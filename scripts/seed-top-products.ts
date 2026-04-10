/**
 * Layer 1 — Seed top US grooming + supplement products.
 *
 * Resolves each entry in `lib/seed/top-grooming-targets.ts` and
 * `lib/seed/top-supplement-targets.ts` to a real barcode via targeted
 * OBF / DSLD search, then upserts the authoritative upstream data.
 *
 * This is the "guaranteed floor" — after a successful run, the highest-
 * value SKUs are present in the DB regardless of OBF/DSLD completeness.
 *
 * Targets that can't be resolved are printed at the end as a catalog gap
 * report — these become candidates for the M3 user-submission pipeline.
 *
 * Usage:
 *   npx tsx scripts/seed-top-products.ts             # all targets
 *   npx tsx scripts/seed-top-products.ts grooming    # grooming only
 *   npx tsx scripts/seed-top-products.ts supplements # supplements only
 *
 * Idempotent — safe to re-run. Every upstream request is rate-limited.
 */

import { readFileSync } from 'fs';
import { resolve } from 'path';

// Load .env if present (tsx doesn't auto-load)
try {
  const envPath = resolve(__dirname, '..', '.env');
  const envContent = readFileSync(envPath, 'utf-8');
  for (const line of envContent.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const value = trimmed.slice(eqIdx + 1).trim();
    if (!process.env[key]) process.env[key] = value;
  }
} catch {}

import { fetchObfProduct } from '../lib/sources/openbeautyfacts';
import {
  searchDsld,
  fetchDsldLabel,
  normalizeDsldUpc,
} from '../lib/sources/dsld';
import { normalizeObfProduct, normalizeDsldLabel } from '../lib/normalize';
import { scoreProduct } from '../lib/scoring';
import { inferSubcategory } from '../lib/subcategory';
import { getDb, closeDb } from '../db/client';
import { upsertProduct } from '../lib/cron/ingest-helpers';
import {
  TOP_GROOMING_TARGETS,
  type GroomingTarget,
} from '../lib/seed/top-grooming-targets';
import {
  TOP_SUPPLEMENT_TARGETS,
  type SupplementTarget,
} from '../lib/seed/top-supplement-targets';

const OBF_SEARCH_URL = 'https://world.openbeautyfacts.org/cgi/search.pl';
const OBF_RATE_LIMIT_MS = 400; // ~2.5 req/s
const DSLD_RATE_LIMIT_MS = 600; // ~1.5 req/s

type Mode = 'all' | 'grooming' | 'supplements';

type Resolution = {
  resolved: number;
  skipped: number;
  gaps: string[];
};

function delay(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

function tokensMatch(text: string, keywords: string[]): boolean {
  const lower = text.toLowerCase();
  return keywords.every((kw) => lower.includes(kw.toLowerCase()));
}

// ── OBF search ─────────────────────────────────────────────────────────────

type ObfSearchHit = {
  code?: string;
  product_name?: string;
  product_name_en?: string;
  brands?: string;
};

async function searchObf(
  query: string,
  pageSize = 20,
): Promise<ObfSearchHit[]> {
  const userAgent = process.env.OFF_USER_AGENT;
  if (!userAgent) throw new Error('OFF_USER_AGENT env var required');

  const params = new URLSearchParams({
    search_terms: query,
    action: 'process',
    json: '1',
    page_size: String(pageSize),
  });

  const response = await fetch(`${OBF_SEARCH_URL}?${params}`, {
    headers: { 'User-Agent': userAgent, Accept: 'application/json' },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) return [];
  const data = (await response.json()) as { products?: ObfSearchHit[] };
  return (data.products ?? []).filter((p) => p.code && /^\d{6,14}$/.test(p.code));
}

// ── Grooming resolver ──────────────────────────────────────────────────────

async function resolveGroomingTarget(
  db: ReturnType<typeof getDb>,
  target: GroomingTarget,
): Promise<'resolved' | 'skipped' | 'gap'> {
  // If a known UPC is provided, skip search.
  let barcode = target.upc;

  if (!barcode) {
    const hits = await searchObf(target.query, 20);
    await delay(OBF_RATE_LIMIT_MS);

    // Score hits: all must-match keywords present in brand+name text.
    const matches = hits.filter((hit) => {
      const text = [hit.product_name, hit.product_name_en, hit.brands]
        .filter(Boolean)
        .join(' ');
      return tokensMatch(text, target.mustMatchKeywords);
    });

    if (matches.length === 0) {
      return 'gap';
    }
    barcode = matches[0].code!;
  }

  try {
    const obfData = await fetchObfProduct(barcode);
    await delay(OBF_RATE_LIMIT_MS);

    if (!obfData) return 'gap';

    const product = normalizeObfProduct(obfData, barcode);
    if (product.data_completeness === 'barcode_only') {
      return 'skipped';
    }

    // Layer 1 overrides inference for precision
    const subcategory =
      target.subcategoryHint ??
      inferSubcategory(
        product.name,
        product.category,
        obfData.categories_tags,
      );

    const score = scoreProduct({ product });
    const id = await upsertProduct(db, product, 'obf', score, subcategory);
    if (!id) return 'skipped';

    console.log(
      `  + [${target.brand}] ${product.name} → ${barcode}, score=${
        score?.overall_score ?? 'N/A'
      }, sub=${subcategory ?? 'none'}`,
    );
    return 'resolved';
  } catch (err) {
    console.warn(`  ! fetch failed for ${barcode}: ${err}`);
    return 'skipped';
  }
}

// ── Supplement resolver ────────────────────────────────────────────────────

async function resolveSupplementTarget(
  db: ReturnType<typeof getDb>,
  target: SupplementTarget,
): Promise<'resolved' | 'skipped' | 'gap'> {
  // DSLD search
  let hits;
  try {
    const result = await searchDsld(target.query, { size: 15 });
    hits = result.hits;
  } catch (err) {
    console.warn(`  ! DSLD search failed for "${target.query}": ${err}`);
    return 'skipped';
  }
  await delay(DSLD_RATE_LIMIT_MS);

  // Filter by keyword match on brandName + fullName
  const matches = hits.filter((hit) => {
    const text = [hit._source.brandName, hit._source.fullName]
      .filter(Boolean)
      .join(' ');
    return tokensMatch(text, target.mustMatchKeywords);
  });

  if (matches.length === 0) {
    return 'gap';
  }

  // Try each candidate in order — many DSLD labels have no UPC.
  for (const hit of matches.slice(0, 5)) {
    try {
      const label = await fetchDsldLabel(hit._id);
      await delay(DSLD_RATE_LIMIT_MS);
      if (!label) continue;

      const barcode = normalizeDsldUpc(label.upcSku);
      if (!barcode) continue;

      const product = normalizeDsldLabel(label, barcode);
      if (product.data_completeness === 'barcode_only') continue;

      const subcategory =
        target.subcategoryHint ??
        inferSubcategory(product.name, product.category);

      const score = scoreProduct({ product });
      const id = await upsertProduct(db, product, 'dsld', score, subcategory);
      if (!id) continue;

      console.log(
        `  + [${target.brand}] ${product.name} → ${barcode}, score=${
          score?.overall_score ?? 'N/A'
        }, sub=${subcategory ?? 'none'}`,
      );
      return 'resolved';
    } catch (err) {
      console.warn(`  ! label fetch failed for DSLD id=${hit._id}: ${err}`);
    }
  }

  return 'gap';
}

// ── Main ───────────────────────────────────────────────────────────────────

async function runGrooming(
  db: ReturnType<typeof getDb>,
): Promise<Resolution> {
  console.log(`\n═══ GROOMING (${TOP_GROOMING_TARGETS.length} targets) ═══\n`);
  const result: Resolution = { resolved: 0, skipped: 0, gaps: [] };

  for (const target of TOP_GROOMING_TARGETS) {
    process.stdout.write(`  → ${target.brand} · ${target.name}... `);
    const status = await resolveGroomingTarget(db, target);
    if (status === 'resolved') {
      result.resolved++;
      process.stdout.write('\n');
    } else if (status === 'gap') {
      result.gaps.push(`${target.brand} — ${target.name}`);
      process.stdout.write('GAP\n');
    } else {
      result.skipped++;
      process.stdout.write('skipped\n');
    }
  }
  return result;
}

async function runSupplements(
  db: ReturnType<typeof getDb>,
): Promise<Resolution> {
  console.log(
    `\n═══ SUPPLEMENTS (${TOP_SUPPLEMENT_TARGETS.length} targets) ═══\n`,
  );
  const result: Resolution = { resolved: 0, skipped: 0, gaps: [] };

  for (const target of TOP_SUPPLEMENT_TARGETS) {
    process.stdout.write(`  → ${target.brand} · ${target.name}... `);
    const status = await resolveSupplementTarget(db, target);
    if (status === 'resolved') {
      result.resolved++;
      process.stdout.write('\n');
    } else if (status === 'gap') {
      result.gaps.push(`${target.brand} — ${target.name}`);
      process.stdout.write('GAP\n');
    } else {
      result.skipped++;
      process.stdout.write('skipped\n');
    }
  }
  return result;
}

function printGapReport(label: string, gaps: string[]): void {
  if (gaps.length === 0) return;
  console.log(`\n--- Catalog gaps: ${label} (${gaps.length}) ---`);
  console.log(
    'These top SKUs could not be resolved via upstream sources and are',
  );
  console.log(
    'candidates for the M3 user-submission pipeline (see CATALOG-GAP-STRATEGY.md).',
  );
  for (const gap of gaps) console.log(`  · ${gap}`);
}

async function main() {
  const mode: Mode = (process.argv[2] as Mode) ?? 'all';
  if (!['all', 'grooming', 'supplements'].includes(mode)) {
    console.error(`Unknown mode: ${mode}. Use "all", "grooming", or "supplements".`);
    process.exit(1);
  }

  console.log(`Layer 1 — Top products seed (mode: ${mode})`);

  const db = getDb();
  const results: Record<string, Resolution> = {};

  if (mode === 'all' || mode === 'grooming') {
    results.grooming = await runGrooming(db);
  }
  if (mode === 'all' || mode === 'supplements') {
    results.supplements = await runSupplements(db);
  }

  // Summary
  console.log('\n═══ Summary ═══');
  for (const [label, result] of Object.entries(results)) {
    console.log(
      `  ${label.padEnd(12)} resolved=${result.resolved}  skipped=${
        result.skipped
      }  gaps=${result.gaps.length}`,
    );
  }
  for (const [label, result] of Object.entries(results)) {
    printGapReport(label, result.gaps);
  }

  await closeDb();
}

main().catch((err) => {
  console.error('\nSeed failed:', err);
  closeDb().finally(() => process.exit(1));
});

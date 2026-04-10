/**
 * Layer 2 — Broad DSLD brand search seed for supplements.
 *
 * Mirrors `scripts/seed-grooming.ts` but for the DSLD supplement catalog.
 * Two passes:
 *   A. Brand pass: DSLD search per brand, pull labels, normalize UPC, upsert.
 *   B. Category pass: common supplement category terms (whey, creatine,
 *      fish oil, multivitamin, etc.) — catches well-known SKUs that might
 *      not appear in the brand-name search.
 *
 * Layer 1 (`scripts/seed-top-products.ts`) handles the curated top-SKU
 * floor for supplements. This script fills the long tail.
 *
 * Note on DSLD: the underlying cron job (`/api/cron/dsld-sync`) is the
 * primary continuous ingest path — this script is for bootstrap + manual
 * catch-up runs. Rate limits are conservative (DSLD has intermittent 500s).
 *
 * Usage:
 *   npx tsx scripts/seed-supplements.ts            # both passes
 *   npx tsx scripts/seed-supplements.ts brands     # brand pass only
 *   npx tsx scripts/seed-supplements.ts category   # category pass only
 */

import { readFileSync } from 'fs';
import { resolve } from 'path';

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

import { searchDsld, fetchDsldLabel, normalizeDsldUpc } from '../lib/sources/dsld';
import { normalizeDsldLabel } from '../lib/normalize';
import { scoreProduct } from '../lib/scoring';
import { inferSubcategory } from '../lib/subcategory';
import { getDb, closeDb } from '../db/client';
import { upsertProduct } from '../lib/cron/ingest-helpers';

const TARGET_BRANDS = [
  'Optimum Nutrition',
  'Thorne',
  'NOW Foods',
  'Nature Made',
  'Centrum',
  'Garden of Life',
  'MuscleTech',
  'Dymatize',
  'Ghost',
  'Cellucor',
  'BSN',
  'Nordic Naturals',
  'Life Extension',
  'Jarrow Formulas',
  'Solgar',
  'Pure Encapsulations',
  'Onnit',
  'Nutricost',
  'BulkSupplements',
  'Ritual',
  'MaryRuth Organics',
];

const CATEGORY_QUERIES: { query: string; hint: string }[] = [
  { query: 'whey protein', hint: 'protein' },
  { query: 'plant protein', hint: 'protein' },
  { query: 'casein protein', hint: 'protein' },
  { query: 'creatine monohydrate', hint: 'pre_workout' },
  { query: 'pre workout', hint: 'pre_workout' },
  { query: 'multivitamin men', hint: 'multivitamin' },
  { query: 'multivitamin daily', hint: 'multivitamin' },
  { query: 'fish oil omega 3', hint: 'omega' },
  { query: 'krill oil', hint: 'omega' },
  { query: 'magnesium glycinate', hint: 'omega' },
  { query: 'vitamin d3', hint: 'multivitamin' },
  { query: 'zinc', hint: 'multivitamin' },
  { query: 'probiotic capsule', hint: 'probiotic' },
  { query: 'ashwagandha', hint: 'testosterone' },
  { query: 'test booster', hint: 'testosterone' },
];

const MAX_HITS_PER_QUERY = 25;
const DELAY_MS = 600; // DSLD: 1.5 req/s

type Pass = 'all' | 'brands' | 'category';
type Totals = { upserted: number; skipped: number; errors: number };

function delay(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

async function ingestFromQuery(
  db: ReturnType<typeof getDb>,
  query: string,
  subcategoryHint?: string,
  seen?: Set<string>,
): Promise<Totals> {
  const totals: Totals = { upserted: 0, skipped: 0, errors: 0 };

  let result;
  try {
    result = await searchDsld(query, { size: MAX_HITS_PER_QUERY });
  } catch (err) {
    console.warn(`  ! search "${query}" failed: ${err}`);
    return totals;
  }
  await delay(DELAY_MS);

  console.log(`  ${result.hits.length}/${result.total} hits`);

  for (const hit of result.hits) {
    if (seen?.has(hit._id)) {
      totals.skipped++;
      continue;
    }
    seen?.add(hit._id);

    try {
      const label = await fetchDsldLabel(hit._id);
      await delay(DELAY_MS);
      if (!label) {
        totals.skipped++;
        continue;
      }

      const barcode = normalizeDsldUpc(label.upcSku);
      if (!barcode) {
        totals.skipped++;
        continue;
      }

      const product = normalizeDsldLabel(label, barcode);
      if (product.data_completeness === 'barcode_only') {
        totals.skipped++;
        continue;
      }

      const subcategory =
        subcategoryHint ?? inferSubcategory(product.name, product.category);

      const score = scoreProduct({ product });
      const id = await upsertProduct(db, product, 'dsld', score, subcategory);
      if (id) {
        totals.upserted++;
      } else {
        totals.errors++;
      }
    } catch (err) {
      console.warn(`    ! label ${hit._id}: ${err}`);
      totals.errors++;
    }
  }
  return totals;
}

async function brandPass(db: ReturnType<typeof getDb>): Promise<Totals> {
  console.log(`\n═══ Brand pass (${TARGET_BRANDS.length} brands) ═══`);
  const running: Totals = { upserted: 0, skipped: 0, errors: 0 };
  const seen = new Set<string>();

  for (const brand of TARGET_BRANDS) {
    console.log(`\nBrand: ${brand}`);
    const totals = await ingestFromQuery(db, brand, undefined, seen);
    running.upserted += totals.upserted;
    running.skipped += totals.skipped;
    running.errors += totals.errors;
    console.log(
      `  → upserted=${totals.upserted} skipped=${totals.skipped} errors=${totals.errors}`,
    );
  }
  return running;
}

async function categoryPass(db: ReturnType<typeof getDb>): Promise<Totals> {
  console.log(
    `\n═══ Category pass (${CATEGORY_QUERIES.length} queries) ═══`,
  );
  const running: Totals = { upserted: 0, skipped: 0, errors: 0 };
  const seen = new Set<string>();

  for (const { query, hint } of CATEGORY_QUERIES) {
    console.log(`\nQuery: "${query}" (hint: ${hint})`);
    const totals = await ingestFromQuery(db, query, hint, seen);
    running.upserted += totals.upserted;
    running.skipped += totals.skipped;
    running.errors += totals.errors;
    console.log(
      `  → upserted=${totals.upserted} skipped=${totals.skipped} errors=${totals.errors}`,
    );
  }
  return running;
}

async function main() {
  const pass: Pass = (process.argv[2] as Pass) ?? 'all';
  if (!['all', 'brands', 'category'].includes(pass)) {
    console.error(`Unknown pass: ${pass}. Use "all", "brands", or "category".`);
    process.exit(1);
  }

  console.log(`Layer 2 — Supplement seed (pass: ${pass})`);
  const db = getDb();
  const results: Record<string, Totals> = {};

  if (pass === 'all' || pass === 'brands') {
    results.brands = await brandPass(db);
  }
  if (pass === 'all' || pass === 'category') {
    results.category = await categoryPass(db);
  }

  console.log('\n═══ Summary ═══');
  for (const [label, totals] of Object.entries(results)) {
    console.log(
      `  ${label.padEnd(12)} upserted=${totals.upserted}  skipped=${totals.skipped}  errors=${totals.errors}`,
    );
  }

  await closeDb();
}

main().catch((err) => {
  console.error('Seed failed:', err);
  closeDb().finally(() => process.exit(1));
});

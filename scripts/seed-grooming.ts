/**
 * Layer 2 — Broad OBF brand + subcategory seed for grooming.
 *
 * Two passes:
 *   A. Brand pass: for each brand in TARGET_BRANDS, search OBF by brand
 *      name and upsert every returned product.
 *   B. Subcategory pass: for each subcategory query, search OBF and upsert
 *      matches that look like men's grooming (category inferred from tags).
 *
 * Layer 1 (`scripts/seed-top-products.ts`) handles the guaranteed top-SKU
 * floor. This script fills the long tail with whatever OBF carries beyond
 * those targets. Together they form the cascading seed described in
 * CATALOG-GAP-STRATEGY.md §3.1 + §3.3.
 *
 * Idempotent — safe to re-run. Same `upsertProduct` helper as the crons.
 *
 * Usage:
 *   npx tsx scripts/seed-grooming.ts          # both passes
 *   npx tsx scripts/seed-grooming.ts brands   # brand pass only
 *   npx tsx scripts/seed-grooming.ts sub      # subcategory pass only
 */

import { readFileSync } from 'fs';
import { resolve } from 'path';

// Load .env if present (Node 20 --env-file only works with node, not tsx)
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
import { normalizeObfProduct } from '../lib/normalize';
import { scoreProduct } from '../lib/scoring';
import { inferSubcategory } from '../lib/subcategory';
import { getDb, closeDb } from '../db/client';
import { upsertProduct } from '../lib/cron/ingest-helpers';

/**
 * Brand pass — each entry goes to OBF's search endpoint as
 * `search_terms=<brand>`. More entries = more breadth.
 */
const TARGET_BRANDS = [
  // Mass-market US men's grooming
  'Old Spice',
  'Dove Men+Care',
  'Nivea Men',
  'Axe',
  'Gillette',
  'Speed Stick',
  'Suave Men',
  // Natural / boutique
  'Dr. Squatch',
  'Every Man Jack',
  "Harry's",
  'Duke Cannon',
  'Bulldog',
  'Brickell',
  // Premium
  'Jack Black',
  'Cremo',
  'Baxter of California',
  "Kiehl's",
  'Lab Series',
  'American Crew',
  // Sunscreen
  'Neutrogena',
  'Banana Boat',
  'Coppertone',
  'EltaMD',
  'La Roche-Posay',
  // Oral care (bathroom staples)
  'Crest',
  'Colgate',
  'Sensodyne',
];

/**
 * Subcategory pass — searches that surface products we care about
 * regardless of brand. Paired with a hint so the upsert stamps the
 * correct subcategory even when the product name is ambiguous.
 */
const SUBCATEGORY_QUERIES: { query: string; hint: string }[] = [
  { query: 'mens deodorant', hint: 'deodorant' },
  { query: 'mens antiperspirant', hint: 'deodorant' },
  { query: 'mens body wash', hint: 'body_wash' },
  { query: 'mens shampoo', hint: 'shampoo' },
  { query: 'mens face wash', hint: 'cleanser' },
  { query: 'mens moisturizer', hint: 'moisturizer' },
  { query: 'shave cream', hint: 'shave' },
  { query: 'shave gel', hint: 'shave' },
  { query: 'aftershave', hint: 'shave' },
  { query: 'beard oil', hint: 'beard' },
  { query: 'beard balm', hint: 'beard' },
  { query: 'pomade', hint: 'hair_styling' },
  { query: 'sunscreen spf 50', hint: 'sunscreen' },
  { query: 'sunscreen spf 30', hint: 'sunscreen' },
  { query: 'bar soap mens', hint: 'soap' },
];

const OBF_SEARCH_URL = 'https://world.openbeautyfacts.org/cgi/search.pl';
const PAGE_SIZE = 50; // bumped from 20 for broader coverage
const RATE_LIMIT_MS = 400;

type Pass = 'all' | 'brands' | 'sub';

type SearchHit = {
  code?: string;
  product_name?: string;
  brands?: string;
};

async function searchObf(query: string): Promise<string[]> {
  const userAgent = process.env.OFF_USER_AGENT;
  if (!userAgent) throw new Error('OFF_USER_AGENT env var required');

  const params = new URLSearchParams({
    search_terms: query,
    action: 'process',
    json: '1',
    page_size: String(PAGE_SIZE),
  });

  const response = await fetch(`${OBF_SEARCH_URL}?${params}`, {
    headers: { 'User-Agent': userAgent, Accept: 'application/json' },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    console.warn(`  Search failed for "${query}": HTTP ${response.status}`);
    return [];
  }
  const data = (await response.json()) as { products?: SearchHit[] };
  return (data.products ?? [])
    .map((p) => p.code)
    .filter((code): code is string => !!code && /^\d{6,14}$/.test(code));
}

function delay(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

type Totals = { upserted: number; skipped: number; errors: number };

async function ingestBarcodes(
  db: ReturnType<typeof getDb>,
  barcodes: string[],
  subcategoryHint?: string,
): Promise<Totals> {
  const totals: Totals = { upserted: 0, skipped: 0, errors: 0 };

  for (const barcode of barcodes) {
    try {
      await delay(RATE_LIMIT_MS);
      const obf = await fetchObfProduct(barcode);
      if (!obf) {
        totals.skipped++;
        continue;
      }
      const product = normalizeObfProduct(obf, barcode);
      if (product.data_completeness === 'barcode_only') {
        totals.skipped++;
        continue;
      }

      // Hint wins over inference when provided (subcategory pass).
      // Brand pass leaves subcategory to the inference engine.
      const subcategory =
        subcategoryHint ??
        inferSubcategory(product.name, product.category, obf.categories_tags);

      const score = scoreProduct({ product });
      const id = await upsertProduct(db, product, 'obf', score, subcategory);
      if (id) {
        totals.upserted++;
      } else {
        totals.errors++;
      }
    } catch (err) {
      console.warn(`    ! ${barcode}: ${err}`);
      totals.errors++;
    }
  }
  return totals;
}

async function brandPass(
  db: ReturnType<typeof getDb>,
): Promise<Totals> {
  console.log(`\n═══ Brand pass (${TARGET_BRANDS.length} brands) ═══`);
  const running: Totals = { upserted: 0, skipped: 0, errors: 0 };
  const seen = new Set<string>();

  for (const brand of TARGET_BRANDS) {
    console.log(`\nSearching brand: ${brand}`);
    const barcodes = (await searchObf(brand)).filter((b) => {
      if (seen.has(b)) return false;
      seen.add(b);
      return true;
    });
    console.log(`  ${barcodes.length} new barcodes`);

    const totals = await ingestBarcodes(db, barcodes);
    running.upserted += totals.upserted;
    running.skipped += totals.skipped;
    running.errors += totals.errors;
    console.log(
      `  → upserted=${totals.upserted} skipped=${totals.skipped} errors=${totals.errors}`,
    );
  }
  return running;
}

async function subcategoryPass(
  db: ReturnType<typeof getDb>,
): Promise<Totals> {
  console.log(
    `\n═══ Subcategory pass (${SUBCATEGORY_QUERIES.length} queries) ═══`,
  );
  const running: Totals = { upserted: 0, skipped: 0, errors: 0 };
  const seen = new Set<string>();

  for (const { query, hint } of SUBCATEGORY_QUERIES) {
    console.log(`\nSearching query: "${query}" (hint: ${hint})`);
    const barcodes = (await searchObf(query)).filter((b) => {
      if (seen.has(b)) return false;
      seen.add(b);
      return true;
    });
    console.log(`  ${barcodes.length} new barcodes`);

    const totals = await ingestBarcodes(db, barcodes, hint);
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
  if (!['all', 'brands', 'sub'].includes(pass)) {
    console.error(`Unknown pass: ${pass}. Use "all", "brands", or "sub".`);
    process.exit(1);
  }

  console.log(`Layer 2 — Grooming seed (pass: ${pass})`);
  const db = getDb();
  const results: Record<string, Totals> = {};

  if (pass === 'all' || pass === 'brands') {
    results.brands = await brandPass(db);
  }
  if (pass === 'all' || pass === 'sub') {
    results.subcategory = await subcategoryPass(db);
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

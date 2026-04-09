/**
 * One-off script to preload top men's grooming products from OBF.
 *
 * Searches OBF by brand, fetches full products, normalizes, scores, and
 * upserts into the DB. Target: ~200 products across key brands.
 *
 * Usage:
 *   npx tsx scripts/seed-grooming.ts          # reads .env automatically
 *   DATABASE_URL=... OFF_USER_AGENT=... npx tsx scripts/seed-grooming.ts
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

const TARGET_BRANDS = [
  'Old Spice',
  'Dove Men+Care',
  'Nivea Men',
  'Dr. Squatch',
  'Every Man Jack',
  "Harry's",
  'Duke Cannon',
  'Bulldog',
  'Jack Black',
  'Cremo',
  'Baxter of California',
  'Brickell',
];

const OBF_SEARCH_URL = 'https://world.openbeautyfacts.org/cgi/search.pl';

type SearchResult = {
  count: number;
  products: Array<{
    code?: string;
    product_name?: string;
    brands?: string;
  }>;
};

async function searchObfBrand(brand: string, pageSize = 20): Promise<string[]> {
  const userAgent = process.env.OFF_USER_AGENT;
  if (!userAgent) throw new Error('OFF_USER_AGENT env var required');

  const params = new URLSearchParams({
    search_terms: brand,
    action: 'process',
    json: '1',
    page_size: String(pageSize),
  });

  const response = await fetch(`${OBF_SEARCH_URL}?${params}`, {
    headers: { 'User-Agent': userAgent, Accept: 'application/json' },
    signal: AbortSignal.timeout(15_000),
  });

  if (!response.ok) {
    console.warn(`  Search failed for "${brand}": HTTP ${response.status}`);
    return [];
  }

  const data = (await response.json()) as SearchResult;
  return (data.products ?? [])
    .map((p) => p.code)
    .filter((code): code is string => !!code && /^\d{6,14}$/.test(code));
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  console.log('Seeding grooming products from OBF...\n');

  const db = getDb();
  let totalUpserted = 0;
  let totalSkipped = 0;
  let totalErrors = 0;

  for (const brand of TARGET_BRANDS) {
    console.log(`Searching: ${brand}`);

    try {
      const barcodes = await searchObfBrand(brand);
      console.log(`  Found ${barcodes.length} barcodes`);

      for (const barcode of barcodes) {
        try {
          await delay(300); // Rate limit: ~3 req/s

          const obf = await fetchObfProduct(barcode);
          if (!obf) {
            totalSkipped++;
            continue;
          }

          const product = normalizeObfProduct(obf, barcode);
          if (product.data_completeness === 'barcode_only') {
            totalSkipped++;
            continue;
          }

          const score = scoreProduct({ product });
          const subcategory = inferSubcategory(product.name, product.category);

          const id = await upsertProduct(db, product, 'obf', score, subcategory);
          if (id) {
            totalUpserted++;
            console.log(`  + ${product.name} (${barcode}) → score: ${score?.overall_score ?? 'N/A'}, sub: ${subcategory ?? 'none'}`);
          } else {
            totalErrors++;
          }
        } catch (err) {
          console.warn(`  Error on ${barcode}: ${err}`);
          totalErrors++;
        }
      }
    } catch (err) {
      console.warn(`  Brand search failed: ${err}`);
    }

    console.log();
  }

  console.log('Summary:');
  console.log(`  Upserted: ${totalUpserted}`);
  console.log(`  Skipped:  ${totalSkipped}`);
  console.log(`  Errors:   ${totalErrors}`);

  await closeDb();
}

main().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});

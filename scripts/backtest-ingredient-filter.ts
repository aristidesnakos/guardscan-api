/**
 * Backtest the isPlausibleIngredient filter against the most recent OBF delta.
 *
 * Fetches today's delta file, runs every ingredient token through the new
 * filter, and prints:
 *   - kept_before / kept_after / rejected counts
 *   - the 30 most-frequent rejections (so we can eyeball if any real INCI
 *     names got swept up)
 *   - 30 random rejections (so we don't miss low-frequency false positives)
 *
 * Run:
 *   npx tsx scripts/backtest-ingredient-filter.ts
 *
 * Optional:
 *   OBF_DELTA_FILE=openbeautyfacts_products_…json.gz   pin a specific file
 */

import { gunzipSync } from 'node:zlib';

import { isPlausibleIngredient } from '@/lib/normalize';
import type { ObfProduct } from '@/lib/sources/openbeautyfacts';

const OBF_DELTA_INDEX = 'https://static.openbeautyfacts.org/data/delta/index.txt';
const OBF_DELTA_BASE = 'https://static.openbeautyfacts.org/data/delta';

const HEADER_NOISE = new Set([
  'ingredients', 'ingrédients', 'ingredientes', 'ingredienti',
  'composition', 'zusammensetzung', 'ingrediënten', 'składniki',
  'inci',
]);

function isHeaderNoise(name: string): boolean {
  return HEADER_NOISE.has(name.toLowerCase().trim());
}

async function pickDeltaFile(): Promise<string> {
  const override = process.env.OBF_DELTA_FILE;
  if (override) return override;
  const res = await fetch(OBF_DELTA_INDEX);
  if (!res.ok) throw new Error(`Delta index HTTP ${res.status}`);
  const text = await res.text();
  const files = text.split('\n').map((s) => s.trim()).filter(Boolean).sort();
  if (files.length === 0) throw new Error('Delta index empty');
  return files[files.length - 1];
}

async function fetchDelta(filename: string): Promise<ObfProduct[]> {
  const res = await fetch(`${OBF_DELTA_BASE}/${filename}`);
  if (!res.ok) throw new Error(`Delta fetch HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const text = gunzipSync(buf).toString('utf-8');
  return text
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as ObfProduct);
}

/**
 * Mirror the OLD parseOpenIngredients behavior (no plausibility check) so
 * we can compare against the new behavior token-for-token.
 */
function parseOldStyle(product: ObfProduct): string[] {
  if (product.ingredients && product.ingredients.length > 0) {
    return product.ingredients
      .map((ing) => (ing.text ?? ing.id ?? '').trim())
      .filter((name) => name.length > 0 && !isHeaderNoise(name));
  }
  const text = product.ingredients_text_en ?? product.ingredients_text ?? '';
  if (!text) return [];
  return text
    .replace(/\([^)]*\)/g, '')
    .split(/[,;]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && !isHeaderNoise(s));
}

function pickRandom<T>(arr: T[], n: number): T[] {
  const copy = [...arr];
  const out: T[] = [];
  while (out.length < n && copy.length > 0) {
    const i = Math.floor(Math.random() * copy.length);
    out.push(copy.splice(i, 1)[0]);
  }
  return out;
}

async function main() {
  const filename = await pickDeltaFile();
  console.log(`Backtesting against: ${filename}`);

  const products = await fetchDelta(filename);
  console.log(`Products in file: ${products.length}\n`);

  let keptBefore = 0;
  let keptAfter = 0;
  let productsWithAnyReject = 0;
  let productsEmptiedByFilter = 0;
  const rejectionCounts = new Map<string, number>();

  for (const p of products) {
    const before = parseOldStyle(p);
    keptBefore += before.length;
    let rejectedThisProduct = 0;
    let afterCount = 0;
    for (const name of before) {
      if (isPlausibleIngredient(name)) {
        afterCount++;
      } else {
        rejectedThisProduct++;
        rejectionCounts.set(name, (rejectionCounts.get(name) ?? 0) + 1);
      }
    }
    keptAfter += afterCount;
    if (rejectedThisProduct > 0) productsWithAnyReject++;
    if (before.length > 0 && afterCount === 0) productsEmptiedByFilter++;
  }

  const rejected = keptBefore - keptAfter;
  const rejectPct = keptBefore === 0 ? 0 : (rejected / keptBefore) * 100;

  console.log('── Summary ────────────────────────────────────────────');
  console.log(`Tokens kept (old):        ${keptBefore}`);
  console.log(`Tokens kept (new):        ${keptAfter}`);
  console.log(`Tokens rejected:          ${rejected} (${rejectPct.toFixed(1)}%)`);
  console.log(`Unique rejected strings:  ${rejectionCounts.size}`);
  console.log(`Products w/ ≥1 reject:    ${productsWithAnyReject} / ${products.length}`);
  console.log(`Products emptied by filter: ${productsEmptiedByFilter}`);
  console.log();

  const sorted = [...rejectionCounts.entries()].sort((a, b) => b[1] - a[1]);

  console.log('── Top 30 rejections (eyeball for real INCI) ──────────');
  for (const [name, count] of sorted.slice(0, 30)) {
    console.log(`  ${String(count).padStart(3)}×  ${JSON.stringify(name)}`);
  }
  console.log();

  console.log('── 30 random rejections (long-tail FP check) ──────────');
  const allRejections = [...rejectionCounts.keys()];
  for (const name of pickRandom(allRejections, 30)) {
    console.log(`  ${JSON.stringify(name)}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

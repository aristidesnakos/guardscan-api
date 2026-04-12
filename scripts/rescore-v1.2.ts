/**
 * v1.2.0 rescore sweep — re-score all products scored under earlier versions.
 *
 * v1.2.0 zeroed out positive flag contributions (subtract-only). Products
 * scored under v1.1.x may have inflated scores from positive flags. This
 * script recalculates every product whose `score_breakdown.score_version`
 * is not `v1.2.0` and writes the updated score + breakdown.
 *
 * Idempotent: re-running skips products already at v1.2.0.
 *
 * Usage:
 *   npx dotenv-cli -- npx tsx scripts/rescore-v1.2.ts            # apply
 *   npx dotenv-cli -- npx tsx scripts/rescore-v1.2.ts --dry       # preview only
 *   npx dotenv-cli -- npx tsx scripts/rescore-v1.2.ts --limit 50  # cap rows
 */

import { readFileSync } from 'fs';
import { resolve } from 'path';

// Bootstrap .env before importing the db client.
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

import { eq, inArray, isNotNull, sql } from 'drizzle-orm';
import { closeDb, getDb } from '../db/client';
import { productIngredients, products } from '../db/schema';
import { scoreProduct } from '../lib/scoring';
import { SCORE_VERSION } from '../lib/scoring/constants';
import type { Product } from '../types/guardscan';

type ProductRow = typeof products.$inferSelect;
type IngredientRow = typeof productIngredients.$inferSelect;

const BATCH_SIZE = 100;
const LOG_EVERY = 50;

function reconstructProduct(row: ProductRow, ings: IngredientRow[]): Product {
  return {
    id: row.id,
    barcode: row.barcode,
    name: row.name,
    brand: row.brand ?? '',
    category: row.category as Product['category'],
    subcategory: row.subcategory ?? null,
    image_url: row.imageFront ?? null,
    data_completeness: 'full',
    ingredient_source: row.source === 'dsld' ? 'verified' : 'open_food_facts',
    ingredients: ings
      .sort((a, b) => a.position - b.position)
      .map((ing) => ({
        name: ing.name,
        position: ing.position,
        flag: (ing.flag ?? 'neutral') as Product['ingredients'][number]['flag'],
        reason: ing.reason ?? '',
        fertility_relevant: false,
        testosterone_relevant: false,
      })),
    created_at: row.createdAt.toISOString(),
    updated_at: row.lastSyncedAt.toISOString(),
  };
}

async function main() {
  const dryRun = process.argv.includes('--dry');
  const limitFlag = process.argv.indexOf('--limit');
  const limit = limitFlag >= 0 ? parseInt(process.argv[limitFlag + 1] ?? '0', 10) : 0;

  console.log(
    `v1.2.0 rescore sweep (${dryRun ? 'DRY RUN' : 'APPLY'}${limit ? `, limit=${limit}` : ''})`,
  );
  console.log(`Target version: ${SCORE_VERSION}\n`);

  const db = getDb();

  // 1. Select scored products whose score_version != current SCORE_VERSION.
  //    Products with NULL score are handled by rescore-products.ts, not here.
  const candidates = await db
    .select()
    .from(products)
    .where(
      isNotNull(products.score),
    );

  // Filter in JS: only products whose breakdown has a different score_version.
  const stale = candidates.filter((row) => {
    const breakdown = row.scoreBreakdown as { score_version?: string } | null;
    return breakdown?.score_version !== SCORE_VERSION;
  });

  console.log(`Found ${candidates.length} scored products total.`);
  console.log(`  ${stale.length} scored under older versions (need rescore).`);
  console.log(`  ${candidates.length - stale.length} already at ${SCORE_VERSION} (skipped).\n`);

  if (stale.length === 0) {
    console.log('Nothing to rescore.');
    await closeDb();
    return;
  }

  // 2. Batch-fetch ingredients.
  const ingsByProduct = new Map<string, IngredientRow[]>();
  const ids = stale.map((c) => c.id);
  for (let i = 0; i < ids.length; i += BATCH_SIZE) {
    const chunk = ids.slice(i, i + BATCH_SIZE);
    const rows = await db
      .select()
      .from(productIngredients)
      .where(inArray(productIngredients.productId, chunk));
    for (const r of rows) {
      const list = ingsByProduct.get(r.productId) ?? [];
      list.push(r);
      ingsByProduct.set(r.productId, list);
    }
  }

  // 3. Cap at --limit.
  const rows = limit > 0 ? stale.slice(0, limit) : stale;
  if (limit > 0 && stale.length > limit) {
    console.log(`--limit ${limit} → processing first ${rows.length} of ${stale.length}.\n`);
  }

  // 4. Rescore loop.
  let scored = 0;
  let unchanged = 0;
  let skippedNoIngredients = 0;
  let skippedNullScore = 0;
  const deltas: Array<{ name: string; category: string; old: number; new_: number; delta: number }> = [];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const ings = ingsByProduct.get(row.id) ?? [];

    if (ings.length === 0) {
      skippedNoIngredients++;
      continue;
    }

    const product = reconstructProduct(row, ings);
    const breakdown = scoreProduct({ product });

    if (!breakdown) {
      skippedNullScore++;
      continue;
    }

    const oldScore = row.score!;
    const newScore = breakdown.overall_score;
    const delta = newScore - oldScore;

    if (delta !== 0 && deltas.length < 20) {
      deltas.push({
        name: product.name.slice(0, 50),
        category: product.category,
        old: oldScore,
        new_: newScore,
        delta,
      });
    }

    if (delta === 0) {
      unchanged++;
    }

    scored++;

    if (!dryRun) {
      await db
        .update(products)
        .set({
          score: breakdown.overall_score,
          scoreBreakdown: breakdown,
        })
        .where(eq(products.id, row.id));
    }

    if ((i + 1) % LOG_EVERY === 0) {
      console.log(
        `  progress: ${i + 1}/${rows.length}  scored=${scored}  unchanged=${unchanged}`,
      );
    }
  }

  // 5. Summary.
  console.log('\n═══ v1.2.0 Rescore Summary ═══');
  console.log(`  stale products:          ${stale.length}`);
  console.log(`  processed this run:      ${rows.length}`);
  console.log(`  rescored:                ${scored}`);
  console.log(`    score changed:         ${scored - unchanged}`);
  console.log(`    score unchanged:       ${unchanged}`);
  console.log(`  skipped (no ingredients): ${skippedNoIngredients}`);
  console.log(`  skipped (scorer null):   ${skippedNullScore}`);

  if (deltas.length > 0) {
    console.log('\n  Score changes (up to 20):');
    console.log('    Category   Old → New  Delta  Product');
    for (const d of deltas) {
      const sign = d.delta > 0 ? '+' : '';
      console.log(
        `    ${d.category.padEnd(10)} ${String(d.old).padStart(3)} → ${String(d.new_).padStart(3)}  ${(sign + d.delta).padStart(4)}   ${d.name}`,
      );
    }
  }

  if (dryRun) {
    console.log('\n  (dry run — nothing was written)');
  }

  await closeDb();
}

main().catch((err) => {
  console.error('Rescore v1.2 failed:', err);
  closeDb().finally(() => process.exit(1));
});

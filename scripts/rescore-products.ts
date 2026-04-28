/**
 * Task 2 Phase A — Local rescore of products that already have ingredients.
 *
 * Selects all products where `score IS NULL` and at least one row exists in
 * `product_ingredients`, reconstructs the canonical `Product` shape from DB,
 * calls the pure `scoreProduct` function (no network), and writes back
 * `score` + `score_breakdown`.
 *
 * Idempotent:
 *   - Only touches rows where `score IS NULL` (guarded in both the SELECT and
 *     the UPDATE WHERE clause).
 *   - Never overwrites an existing score.
 *
 * Supplement note (sprint plan rev 3, Option A):
 *   `scoreProduct` returns `null` for `category === 'supplement'` until M2
 *   supplement scoring lands. This script counts supplements as "skipped"
 *   and reports them separately in the summary. They will remain `score NULL`
 *   until a dedicated supplement scorer ships.
 *
 * Usage:
 *   npx tsx scripts/rescore-products.ts            # apply
 *   npx tsx scripts/rescore-products.ts --dry      # preview only
 *   npx tsx scripts/rescore-products.ts --limit 50 # cap rows touched
 */

import { readFileSync } from 'fs';
import { resolve } from 'path';

// Bootstrap .env before importing the db client (matches backfill-subcategories.ts).
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

import { and, asc, eq, isNull, inArray } from 'drizzle-orm';
import { closeDb, getDb } from '../db/client';
import { productIngredients, products } from '../db/schema';
import { hydrateIngredient } from '../lib/dictionary/resolve';
import { scoreProduct } from '../lib/scoring';
import type { Product, ProductCategory } from '../types/guardscan';

type ProductRow = typeof products.$inferSelect;
type IngredientRow = typeof productIngredients.$inferSelect;

type Outcome =
  | { kind: 'scored'; score: number }
  | { kind: 'skipped_supplement' }
  | { kind: 'skipped_no_ingredients' }
  | { kind: 'skipped_null_score' };

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
      .map((ing) => hydrateIngredient(ing, row.category as ProductCategory)),
    created_at: row.createdAt.toISOString(),
    updated_at: row.lastSyncedAt.toISOString(),
  };
}

async function main() {
  const dryRun = process.argv.includes('--dry');
  const limitFlag = process.argv.indexOf('--limit');
  const limit = limitFlag >= 0 ? parseInt(process.argv[limitFlag + 1] ?? '0', 10) : 0;

  console.log(
    `Rescore products (${dryRun ? 'DRY RUN' : 'APPLY'}${limit ? `, limit=${limit}` : ''})`,
  );

  const db = getDb();

  // 1. Select candidate products (score IS NULL). We filter to "has ingredients"
  //    after the fetch because a NOT EXISTS subquery would add a second round trip
  //    for a 1,000-row dataset; simpler to pull and filter in memory.
  const candidates = await db
    .select()
    .from(products)
    .where(isNull(products.score));

  console.log(`\nFound ${candidates.length} products with NULL score.`);

  if (candidates.length === 0) {
    console.log('Nothing to rescore.');
    await closeDb();
    return;
  }

  // 2. Batch-fetch all ingredients for these products in chunks (avoid a huge IN list).
  const ingsByProduct = new Map<string, IngredientRow[]>();
  const ids = candidates.map((c) => c.id);
  for (let i = 0; i < ids.length; i += BATCH_SIZE) {
    const chunk = ids.slice(i, i + BATCH_SIZE);
    const rows = await db
      .select()
      .from(productIngredients)
      .where(inArray(productIngredients.productId, chunk))
      .orderBy(asc(productIngredients.position));
    for (const r of rows) {
      const list = ingsByProduct.get(r.productId) ?? [];
      list.push(r);
      ingsByProduct.set(r.productId, list);
    }
  }

  // 3. Filter to products that actually have ingredients, cap at --limit.
  const workable = candidates.filter((c) => (ingsByProduct.get(c.id)?.length ?? 0) > 0);
  const rows = limit > 0 ? workable.slice(0, limit) : workable;

  console.log(
    `  ${workable.length} have at least one ingredient row; ${candidates.length - workable.length} do not (need Phase B refetch).`,
  );
  if (limit > 0 && workable.length > limit) {
    console.log(`  --limit ${limit} → processing first ${rows.length} rows only.`);
  }

  // 4. Tight rescore loop.
  const outcomes: Record<Outcome['kind'], number> = {
    scored: 0,
    skipped_supplement: 0,
    skipped_no_ingredients: 0, // shouldn't hit, kept for completeness
    skipped_null_score: 0,
  };
  const scoredSamples: Array<{ name: string; category: string; score: number }> = [];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const ings = ingsByProduct.get(row.id) ?? [];
    const product = reconstructProduct(row, ings);

    // Supplements intentionally return null from scoreProduct (M2 blocker).
    if (product.category === 'supplement') {
      outcomes.skipped_supplement++;
      continue;
    }

    const breakdown = scoreProduct({ product });
    if (!breakdown) {
      outcomes.skipped_null_score++;
      continue;
    }

    outcomes.scored++;
    if (scoredSamples.length < 5) {
      scoredSamples.push({
        name: product.name,
        category: product.category,
        score: breakdown.overall_score,
      });
    }

    if (!dryRun) {
      // Idempotent guard: only write if score is still NULL.
      await db
        .update(products)
        .set({
          score: breakdown.overall_score,
          scoreBreakdown: breakdown,
          outcomeFlags: breakdown.outcome_flags,
        })
        .where(and(eq(products.id, row.id), isNull(products.score)));
    }

    if ((i + 1) % LOG_EVERY === 0) {
      console.log(
        `  progress: ${i + 1}/${rows.length}  scored=${outcomes.scored}  skipped_supplement=${outcomes.skipped_supplement}  skipped_null=${outcomes.skipped_null_score}`,
      );
    }
  }

  // 5. Summary.
  console.log('\n═══ Summary ═══');
  console.log(`  candidates (score NULL):      ${candidates.length}`);
  console.log(`    of those, with ingredients: ${workable.length}`);
  console.log(`    processed this run:         ${rows.length}`);
  console.log(`  scored:                       ${outcomes.scored}`);
  console.log(`  skipped (supplement):         ${outcomes.skipped_supplement}`);
  console.log(`  skipped (scorer returned null): ${outcomes.skipped_null_score}`);

  if (scoredSamples.length > 0) {
    console.log('\n  First few successful scores:');
    for (const s of scoredSamples) {
      console.log(`    ${s.category.padEnd(10)} ${String(s.score).padStart(3)}  ${s.name}`);
    }
  }

  if (dryRun) {
    console.log('\n  (dry run — nothing was written)');
  }

  await closeDb();
}

main().catch((err) => {
  console.error('Rescore failed:', err);
  closeDb().finally(() => process.exit(1));
});

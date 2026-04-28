/**
 * Local rescore for catalog backfill.
 *
 * Two modes:
 *   - default — score products where `score IS NULL` (Phase A backfill).
 *     Idempotent: never overwrites an existing score.
 *   - --missing-outcomes — rescore products where `score IS NOT NULL` but
 *     `outcome_flags IS NULL` (M5.1 outcome backfill). Idempotent: only
 *     writes rows that still have NULL outcome_flags.
 *
 * Both modes reconstruct the canonical `Product` shape from DB, call the
 * pure `scoreProduct` function (no network), and write back the relevant
 * columns.
 *
 * Supplements are skipped in both modes — `scoreProduct` returns null for
 * `category === 'supplement'` until M6 supplement scoring lands.
 *
 * Usage:
 *   npx tsx scripts/rescore-products.ts                      # default — score NULL-score
 *   npx tsx scripts/rescore-products.ts --missing-outcomes   # M5.1 backfill
 *   npx tsx scripts/rescore-products.ts --dry                # preview only
 *   npx tsx scripts/rescore-products.ts --limit 50           # cap rows touched
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

import { and, asc, eq, isNotNull, isNull, inArray } from 'drizzle-orm';
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
  const missingOutcomes = process.argv.includes('--missing-outcomes');
  const limitFlag = process.argv.indexOf('--limit');
  const limit = limitFlag >= 0 ? parseInt(process.argv[limitFlag + 1] ?? '0', 10) : 0;

  const mode = missingOutcomes ? 'MISSING-OUTCOMES (M5.1)' : 'NULL-SCORE';
  console.log(
    `Rescore products — ${mode} (${dryRun ? 'DRY RUN' : 'APPLY'}${limit ? `, limit=${limit}` : ''})`,
  );

  const db = getDb();

  // 1. Select candidates. NULL-score mode targets unscored products; missing-
  //    outcomes mode targets scored products with no outcome_flags yet (M5.1
  //    backfill). We filter to "has ingredients" after fetch because a NOT
  //    EXISTS subquery costs a round-trip for a 1k-row dataset.
  const whereClause = missingOutcomes
    ? and(isNotNull(products.score), isNull(products.outcomeFlags))
    : isNull(products.score);

  const candidates = await db.select().from(products).where(whereClause);

  console.log(
    `\nFound ${candidates.length} products with ${missingOutcomes ? 'score but NULL outcome_flags' : 'NULL score'}.`,
  );

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
      // Idempotent guard tied to the active mode:
      //   - NULL-score mode: only write if score is still NULL.
      //   - missing-outcomes mode: only write if outcome_flags is still NULL.
      const guardClause = missingOutcomes
        ? and(eq(products.id, row.id), isNull(products.outcomeFlags))
        : and(eq(products.id, row.id), isNull(products.score));
      await db
        .update(products)
        .set({
          score: breakdown.overall_score,
          scoreBreakdown: breakdown,
          outcomeFlags: breakdown.outcome_flags,
        })
        .where(guardClause);
    }

    if ((i + 1) % LOG_EVERY === 0) {
      console.log(
        `  progress: ${i + 1}/${rows.length}  scored=${outcomes.scored}  skipped_supplement=${outcomes.skipped_supplement}  skipped_null=${outcomes.skipped_null_score}`,
      );
    }
  }

  // 5. Summary.
  const candidateLabel = missingOutcomes
    ? 'candidates (score+ NULL outcomes)'
    : 'candidates (score NULL)         ';
  console.log('\n═══ Summary ═══');
  console.log(`  ${candidateLabel}: ${candidates.length}`);
  console.log(`    of those, with ingredients: ${workable.length}`);
  console.log(`    processed this run:         ${rows.length}`);
  console.log(`  ${missingOutcomes ? 'rescored                    ' : 'scored                      '}: ${outcomes.scored}`);
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

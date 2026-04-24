/**
 * P0 backfill — fix `product_ingredients.normalized` for all existing rows.
 *
 * Background: before P0, both write paths stored
 *   normalized = ing.name.toLowerCase().trim()
 * instead of
 *   normalized = normalizeIngredientName(ing.name)
 *
 * `normalizeIngredientName` additionally strips parentheticals, percentages,
 * footnote markers, and leading underscores — structural noise that
 * `toLowerCase().trim()` leaves in. The `normalized` column is the join key
 * to `ingredient_dictionary.normalized`, so rows written before this fix
 * silently fail every dictionary join.
 *
 * This script recomputes the correct value for every row and updates only
 * the rows where the value has changed. Safe to re-run: a second pass finds
 * zero changed rows and exits immediately.
 *
 * Usage:
 *   npx tsx scripts/backfill-normalized.ts          # apply changes
 *   npx tsx scripts/backfill-normalized.ts --dry    # preview only, no writes
 *   npx tsx scripts/backfill-normalized.ts --limit 200  # cap rows processed
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

import { and, eq } from 'drizzle-orm';
import { closeDb, getDb } from '../db/client';
import { productIngredients } from '../db/schema';
import { normalizeIngredientName } from '../lib/dictionary/resolve';

const LOG_EVERY = 500;

async function main() {
  const dryRun = process.argv.includes('--dry');
  const limitFlag = process.argv.indexOf('--limit');
  const limit = limitFlag >= 0 ? parseInt(process.argv[limitFlag + 1] ?? '0', 10) : 0;

  console.log(
    `Backfill product_ingredients.normalized (${dryRun ? 'DRY RUN' : 'APPLY'}${limit ? `, limit=${limit}` : ''})`,
  );

  const db = getDb();

  console.log('\nFetching all product_ingredients rows...');
  const allRows = await db
    .select({
      productId: productIngredients.productId,
      position: productIngredients.position,
      name: productIngredients.name,
      normalized: productIngredients.normalized,
    })
    .from(productIngredients);

  console.log(`  Total rows: ${allRows.length}`);

  if (allRows.length === 0) {
    console.log('Nothing to backfill.');
    await closeDb();
    return;
  }

  // Identify stale rows — those where stored normalized ≠ correct normalized.
  type StaleRow = {
    productId: string;
    position: number;
    stale: string;
    correct: string;
  };

  const stale: StaleRow[] = [];

  for (const row of allRows) {
    const correct = normalizeIngredientName(row.name);
    if (correct !== row.normalized) {
      stale.push({
        productId: row.productId,
        position: row.position,
        stale: row.normalized,
        correct,
      });
    }
  }

  const unchanged = allRows.length - stale.length;
  console.log(`  Already correct: ${unchanged}`);
  console.log(`  Need update:     ${stale.length}`);

  if (stale.length === 0) {
    console.log('\nAll rows already have correct normalized values. Nothing to do.');
    await closeDb();
    return;
  }

  // Show a sample of what will change.
  const sampleSize = Math.min(5, stale.length);
  console.log(`\n  Sample changes (first ${sampleSize}):`);
  for (const s of stale.slice(0, sampleSize)) {
    console.log(`    "${s.stale}"  →  "${s.correct}"`);
  }

  const toProcess = limit > 0 ? stale.slice(0, limit) : stale;
  if (limit > 0 && stale.length > limit) {
    console.log(`\n  --limit ${limit} → processing first ${toProcess.length} of ${stale.length} stale rows.`);
  }

  if (dryRun) {
    console.log('\n(dry run — no changes written)');
    await closeDb();
    return;
  }

  // Update stale rows one at a time. The composite PK (product_id, position)
  // requires both columns in the WHERE clause — using and(eq, eq).
  console.log(`\nApplying ${toProcess.length} updates...`);

  let updated = 0;
  let errors = 0;

  for (let i = 0; i < toProcess.length; i++) {
    const row = toProcess[i];
    try {
      await db
        .update(productIngredients)
        .set({ normalized: row.correct })
        .where(
          and(
            eq(productIngredients.productId, row.productId),
            eq(productIngredients.position, row.position),
          ),
        );
      updated++;
    } catch (err) {
      errors++;
      console.error(
        `  Error updating (${row.productId}, pos ${row.position}):`,
        String(err),
      );
    }

    if ((i + 1) % LOG_EVERY === 0) {
      console.log(
        `  progress: ${i + 1}/${toProcess.length}  updated=${updated}  errors=${errors}`,
      );
    }
  }

  console.log('\n═══ Summary ═══');
  console.log(`  Total rows:      ${allRows.length}`);
  console.log(`  Already correct: ${unchanged}`);
  console.log(`  Stale (found):   ${stale.length}`);
  console.log(`  Processed:       ${toProcess.length}`);
  console.log(`  Updated:         ${updated}`);
  console.log(`  Errors:          ${errors}`);

  await closeDb();
}

main().catch((err) => {
  console.error('Backfill failed:', err);
  closeDb().finally(() => process.exit(1));
});

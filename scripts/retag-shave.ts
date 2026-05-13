/**
 * One-shot: retag rows whose subcategory is the legacy `shave` key.
 *
 * Background: lib/subcategory.ts previously had a single `shave` bucket
 * covering foam, cream, gel, aftershave, and razors. Split into `shave_prep`
 * (foam/cream/gel) and `aftershave`. This pass reruns the (new) keyword
 * inference against just those rows.
 *
 * Anything the keyword pass can't resolve falls back to `shave_prep` —
 * historically a `shave` tag meant "shave-related consumable" and the bulk
 * of those are creams/gels/foams. Bare names (e.g. just "Shave") are rare.
 *
 * Usage:
 *   npx tsx scripts/retag-shave.ts          # dry-run
 *   npx tsx scripts/retag-shave.ts --apply  # apply
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

import { eq } from 'drizzle-orm';
import { getDb, closeDb } from '../db/client';
import { products } from '../db/schema';
import { inferSubcategory } from '../lib/subcategory';

const FALLBACK = 'shave_prep';

async function main() {
  const apply = process.argv.includes('--apply');
  console.log(`Retag legacy 'shave' subcategory (${apply ? 'APPLY' : 'DRY RUN'})`);

  const db = getDb();
  const rows = await db
    .select({
      id: products.id,
      barcode: products.barcode,
      name: products.name,
      brand: products.brand,
      category: products.category,
    })
    .from(products)
    .where(eq(products.subcategory, 'shave'));

  console.log(`\nLegacy 'shave' rows: ${rows.length}`);

  let toPrep = 0;
  let toAftershave = 0;
  let toFallback = 0;
  let errors = 0;

  for (const row of rows) {
    const inferred = inferSubcategory(row.name, row.category);
    const target = inferred ?? FALLBACK;
    if (target === 'shave_prep') toPrep++;
    else if (target === 'aftershave') toAftershave++;
    else toFallback++;

    const reason = inferred ? '[keyword]' : '[fallback]';
    console.log(`  ${reason.padEnd(11)} → ${target.padEnd(12)} ${row.barcode}  ${row.brand ?? ''} — ${row.name}`);

    if (apply) {
      try {
        await db.update(products).set({ subcategory: target }).where(eq(products.id, row.id));
      } catch (err) {
        errors++;
        console.error(`    update failed:`, err);
      }
    }
  }

  console.log('\n═══ Summary ═══');
  console.log(`  → shave_prep:  ${toPrep}`);
  console.log(`  → aftershave:  ${toAftershave}`);
  console.log(`  → fallback (${FALLBACK}): ${toFallback}`);
  if (apply) console.log(`  errors:        ${errors}`);
  else console.log('\n  (dry run — pass --apply to write)');

  await closeDb();
}

main().catch((err) => {
  console.error('Retag failed:', err);
  closeDb().finally(() => process.exit(1));
});

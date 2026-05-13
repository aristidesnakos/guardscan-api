/**
 * Purge physical-hardware products from the catalog.
 *
 * Scans every row in `products` and deletes those whose name matches the
 * hardware pattern in lib/hardware-filter.ts (razors, combs, brushes,
 * trimmers, loofahs, …). Companion to the intake filter wired into
 * upsertProduct — that prevents future writes; this cleans up history.
 *
 * Cascade behavior: product_ingredients, scan_events, shelf_items all
 * declare ON DELETE CASCADE on their product_id FK (schema.ts). shelf_items
 * has a swapped_from_id with ON DELETE SET NULL — also safe.
 *
 * Usage:
 *   npx tsx scripts/purge-hardware.ts            # dry-run, prints matches
 *   npx tsx scripts/purge-hardware.ts --apply    # actually delete
 *   npx tsx scripts/purge-hardware.ts --limit 50 # cap matches printed/deleted
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
import { isHardware } from '../lib/hardware-filter';

type Match = {
  id: string;
  barcode: string;
  name: string;
  brand: string | null;
  category: 'food' | 'grooming' | 'supplement';
  subcategory: string | null;
};

async function main() {
  const apply = process.argv.includes('--apply');
  const limitFlag = process.argv.indexOf('--limit');
  const limit = limitFlag >= 0 ? parseInt(process.argv[limitFlag + 1], 10) : 0;

  console.log(`Purge hardware (${apply ? 'APPLY' : 'DRY RUN'}${limit ? `, limit=${limit}` : ''})`);

  const db = getDb();
  const rows = await db
    .select({
      id: products.id,
      barcode: products.barcode,
      name: products.name,
      brand: products.brand,
      category: products.category,
      subcategory: products.subcategory,
    })
    .from(products);

  console.log(`\nScanned ${rows.length} products.`);

  const matches: Match[] = [];
  for (const row of rows) {
    if (isHardware(row.name)) {
      matches.push(row);
      if (limit > 0 && matches.length >= limit) break;
    }
  }

  console.log(`\n═══ Matches (${matches.length}) ═══`);
  if (matches.length === 0) {
    console.log('  (none — catalog already consumable-only)');
    await closeDb();
    return;
  }

  // Group by category for readability.
  const byCategory = new Map<string, Match[]>();
  for (const m of matches) {
    const list = byCategory.get(m.category) ?? [];
    list.push(m);
    byCategory.set(m.category, list);
  }
  for (const [cat, list] of byCategory) {
    console.log(`\n  ${cat} (${list.length}):`);
    for (const m of list) {
      const sub = m.subcategory ? ` [${m.subcategory}]` : '';
      const brand = m.brand ? `${m.brand} — ` : '';
      console.log(`    ${m.barcode}  ${brand}${m.name}${sub}`);
    }
  }

  if (!apply) {
    console.log('\n  (dry run — pass --apply to delete)');
    await closeDb();
    return;
  }

  // Delete one at a time so a single FK surprise doesn't take the whole run
  // down. Cascades on product_ingredients/scan_events/shelf_items make this
  // safe; we still log each delete in case the user wants to audit later.
  let deleted = 0;
  let errors = 0;
  for (const m of matches) {
    try {
      await db.delete(products).where(eq(products.id, m.id));
      deleted++;
    } catch (err) {
      errors++;
      console.error(`  delete failed for ${m.barcode}:`, err);
    }
  }

  console.log('\n═══ Summary ═══');
  console.log(`  matched:  ${matches.length}`);
  console.log(`  deleted:  ${deleted}`);
  console.log(`  errors:   ${errors}`);

  await closeDb();
}

main().catch((err) => {
  console.error('Purge failed:', err);
  closeDb().finally(() => process.exit(1));
});

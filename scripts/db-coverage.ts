/**
 * Database coverage diagnostic.
 *
 * Prints the current state of the products table so you can see what's
 * seeded and where the catalog is still sparse. Pure read-only — safe to
 * run any time.
 *
 * Output:
 *   - Total row count, per category, per source, per subcategory
 *   - Scoring coverage: how many rows have scores persisted
 *   - Ingredient coverage: rows with ≥1 persisted ingredient
 *   - Dictionary size
 *   - Top sparse subcategories (fewest rows)
 *   - Recent cron run status
 *
 * Usage:
 *   npx tsx scripts/db-coverage.ts
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

import { sql, isNotNull, isNull, desc } from 'drizzle-orm';
import {
  products,
  productIngredients,
  ingredientDictionary,
  cronState,
  userSubmissions,
} from '../db/schema';
import { getDb, closeDb, isDatabaseConfigured } from '../db/client';

function bar(count: number, max: number, width = 30): string {
  if (max === 0) return '';
  const filled = Math.round((count / max) * width);
  return '█'.repeat(filled) + '░'.repeat(width - filled);
}

function heading(title: string): void {
  console.log(`\n${title}`);
  console.log('─'.repeat(title.length));
}

async function main() {
  if (!isDatabaseConfigured()) {
    console.error('DATABASE_URL is not configured. Set it in .env.');
    process.exit(1);
  }

  const db = getDb();

  console.log('═══════════════════════════════════════════════');
  console.log(' GuardScan — Database Coverage Report');
  console.log('═══════════════════════════════════════════════');

  // ── Products: totals ────────────────────────────────────────────────
  const [{ total = 0 } = { total: 0 }] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(products);

  const [{ withScore = 0 } = { withScore: 0 }] = await db
    .select({ withScore: sql<number>`count(*)::int` })
    .from(products)
    .where(isNotNull(products.score));

  const [{ withBreakdown = 0 } = { withBreakdown: 0 }] = await db
    .select({ withBreakdown: sql<number>`count(*)::int` })
    .from(products)
    .where(isNotNull(products.scoreBreakdown));

  const [{ noScore = 0 } = { noScore: 0 }] = await db
    .select({ noScore: sql<number>`count(*)::int` })
    .from(products)
    .where(isNull(products.score));

  const [{ noSub = 0 } = { noSub: 0 }] = await db
    .select({ noSub: sql<number>`count(*)::int` })
    .from(products)
    .where(isNull(products.subcategory));

  heading('Products — Totals');
  console.log(`  Total rows:             ${total}`);
  console.log(`  With score:             ${withScore}`);
  console.log(`  With score breakdown:   ${withBreakdown}`);
  console.log(`  Missing score:          ${noScore}`);
  console.log(`  Missing subcategory:    ${noSub}`);

  // ── Ingredient coverage ─────────────────────────────────────────────
  const [{ productsWithIng = 0 } = { productsWithIng: 0 }] = await db
    .select({
      productsWithIng: sql<number>`count(distinct ${productIngredients.productId})::int`,
    })
    .from(productIngredients);

  const [{ totalIngredients = 0 } = { totalIngredients: 0 }] = await db
    .select({ totalIngredients: sql<number>`count(*)::int` })
    .from(productIngredients);

  heading('Ingredients — Persistence');
  console.log(`  Products with ≥1 ingredient: ${productsWithIng} / ${total}`);
  console.log(
    `  Total ingredient rows:       ${totalIngredients} (avg ${
      productsWithIng > 0 ? (totalIngredients / productsWithIng).toFixed(1) : '0'
    } per product)`,
  );

  // ── By category ─────────────────────────────────────────────────────
  const byCategory = await db
    .select({
      category: products.category,
      count: sql<number>`count(*)::int`,
    })
    .from(products)
    .groupBy(products.category);

  heading('Products — By Category');
  const maxCat = Math.max(1, ...byCategory.map((r) => r.count));
  for (const row of byCategory) {
    console.log(
      `  ${(row.category ?? 'null').padEnd(12)} ${String(row.count).padStart(
        5,
      )}  ${bar(row.count, maxCat)}`,
    );
  }

  // ── By source ───────────────────────────────────────────────────────
  const bySource = await db
    .select({
      source: products.source,
      count: sql<number>`count(*)::int`,
    })
    .from(products)
    .groupBy(products.source);

  heading('Products — By Source');
  const maxSrc = Math.max(1, ...bySource.map((r) => r.count));
  for (const row of bySource) {
    console.log(
      `  ${(row.source ?? 'null').padEnd(12)} ${String(row.count).padStart(
        5,
      )}  ${bar(row.count, maxSrc)}`,
    );
  }

  // ── By subcategory ──────────────────────────────────────────────────
  const bySub = await db
    .select({
      category: products.category,
      subcategory: products.subcategory,
      count: sql<number>`count(*)::int`,
    })
    .from(products)
    .groupBy(products.category, products.subcategory)
    .orderBy(products.category, desc(sql<number>`count(*)`));

  heading('Products — By Subcategory (Category · Subcategory · Count)');
  const maxSub = Math.max(1, ...bySub.map((r) => r.count));
  for (const row of bySub) {
    const sub = row.subcategory ?? '(unassigned)';
    console.log(
      `  ${row.category.padEnd(11)} ${sub.padEnd(20)} ${String(row.count).padStart(
        5,
      )}  ${bar(row.count, maxSub)}`,
    );
  }

  // ── Sparsest subcategories (excluding unassigned) ───────────────────
  const sparse = bySub
    .filter((r) => r.subcategory !== null)
    .slice()
    .sort((a, b) => a.count - b.count)
    .slice(0, 5);

  if (sparse.length > 0) {
    heading('Sparsest Subcategories (candidates for targeted seeding)');
    for (const row of sparse) {
      console.log(
        `  ${row.category.padEnd(11)} ${
          row.subcategory!.padEnd(20)
        } ${row.count} products`,
      );
    }
  }

  // ── Ingredient dictionary ────────────────────────────────────────────
  const [{ dictTotal = 0 } = { dictTotal: 0 }] = await db
    .select({ dictTotal: sql<number>`count(*)::int` })
    .from(ingredientDictionary);

  const dictByFlag = await db
    .select({
      flag: ingredientDictionary.flag,
      count: sql<number>`count(*)::int`,
    })
    .from(ingredientDictionary)
    .groupBy(ingredientDictionary.flag);

  heading('Ingredient Dictionary');
  console.log(`  Total entries: ${dictTotal}`);
  for (const row of dictByFlag) {
    console.log(`    ${row.flag.padEnd(10)} ${row.count}`);
  }

  // ── User submissions ─────────────────────────────────────────────────
  const submissionsByStatus = await db
    .select({
      status: userSubmissions.status,
      count: sql<number>`count(*)::int`,
    })
    .from(userSubmissions)
    .groupBy(userSubmissions.status);

  if (submissionsByStatus.length > 0) {
    heading('User Submissions — By Status');
    for (const row of submissionsByStatus) {
      console.log(`  ${row.status.padEnd(12)} ${row.count}`);
    }
  }

  // ── Cron state ──────────────────────────────────────────────────────
  const cronRows = await db.select().from(cronState);
  if (cronRows.length > 0) {
    heading('Cron State');
    for (const row of cronRows) {
      const last = row.lastRunAt ? row.lastRunAt.toISOString() : 'never';
      console.log(
        `  ${row.jobName.padEnd(14)} ${(row.lastRunStatus ?? '—').padEnd(8)} ${last}`,
      );
    }
  }

  // ── Readiness hint ──────────────────────────────────────────────────
  heading('Readiness');
  if (total === 0) {
    console.log('  ⚠ Products table is empty. Recommended order:');
    console.log('     1. npm run db:seed:dictionary  (ingredient vocabulary)');
    console.log('     2. npm run db:seed:top          (Layer 1 — top SKUs)');
    console.log('     3. npm run db:seed:grooming     (Layer 2 — OBF breadth)');
    console.log('     4. npm run db:seed:supplements  (Layer 2 — DSLD breadth)');
  } else if (dictTotal === 0) {
    console.log('  ⚠ Dictionary is empty — scoring uses the inline seed only.');
    console.log('     Run: npm run db:seed:dictionary');
  } else if (withScore < total * 0.9) {
    console.log(
      `  ⚠ ${total - withScore} products have no score. Consider a rescore pass.`,
    );
  } else if (productsWithIng < total * 0.8) {
    console.log(
      `  ⚠ ${total - productsWithIng} products have no persisted ingredients.`,
    );
    console.log('     Re-running the seed scripts will backfill most of these.');
  } else {
    console.log('  ✓ Catalog looks healthy. Schedule-driven crons handle ongoing growth.');
  }

  await closeDb();
}

main().catch((err) => {
  console.error('\nCoverage report failed:', err);
  closeDb().finally(() => process.exit(1));
});

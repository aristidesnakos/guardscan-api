/**
 * Backfill / repair subcategories on existing product rows.
 *
 * Runs the hybrid classifier (keyword pass → LLM fallback) against every
 * row's stored name + category and updates rows where the result differs
 * from what's persisted. Used after edits to `lib/subcategory.ts` or when
 * OPENROUTER_API_KEY is first added to fill in rows that the keyword pass
 * can't resolve.
 *
 * Idempotent — safe to re-run. Prints a changelog of every update.
 *
 * Rate limiting: when the LLM actually fires (keyword returned null), we
 * sleep 200ms between rows so we don't get throttled by OpenRouter. Rows
 * the keyword pass already handled are free and run back-to-back.
 *
 * Usage:
 *   npx tsx scripts/backfill-subcategories.ts                 # apply updates
 *   npx tsx scripts/backfill-subcategories.ts --dry           # preview only
 *   npx tsx scripts/backfill-subcategories.ts --no-llm        # keyword only
 *   npx tsx scripts/backfill-subcategories.ts --limit 50      # cap rows touched
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
import {
  classifySubcategoryWithLlm,
  isLlmClassifierEnabled,
} from '../lib/llm/classifier';

type Change = {
  barcode: string;
  name: string;
  category: 'food' | 'grooming' | 'supplement';
  from: string | null;
  to: string | null;
  via: 'keyword' | 'llm';
};

const LLM_DELAY_MS = 200;

function delay(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

async function main() {
  const dryRun = process.argv.includes('--dry');
  const disableLlm = process.argv.includes('--no-llm');
  const limitFlag = process.argv.indexOf('--limit');
  const limit = limitFlag >= 0 ? parseInt(process.argv[limitFlag + 1], 10) : 0;

  const llmEnabled = !disableLlm && isLlmClassifierEnabled();

  console.log(
    `Backfill subcategories (${dryRun ? 'DRY RUN' : 'APPLY'}, llm=${llmEnabled ? 'on' : 'off'}${limit ? `, limit=${limit}` : ''})`,
  );

  if (!disableLlm && !isLlmClassifierEnabled()) {
    console.log(
      '  note: OPENROUTER_API_KEY is not set — keyword-only (LLM fallback skipped).',
    );
  }

  const db = getDb();
  const allRows = await db
    .select({
      id: products.id,
      barcode: products.barcode,
      name: products.name,
      category: products.category,
      subcategory: products.subcategory,
    })
    .from(products);

  const rows = limit > 0 ? allRows.slice(0, limit) : allRows;

  console.log(
    `\nLoaded ${rows.length} products${limit > 0 && allRows.length > limit ? ` (capped from ${allRows.length})` : ''}.`,
  );

  const changes: Change[] = [];
  let sameCount = 0;
  let llmCalls = 0;

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];

    // Pass 1: keyword.
    let inferred = inferSubcategory(row.name, row.category);
    let via: 'keyword' | 'llm' = 'keyword';

    // Pass 2: LLM, only if keyword returned null and LLM is enabled.
    if (!inferred && llmEnabled) {
      await delay(LLM_DELAY_MS);
      inferred = await classifySubcategoryWithLlm(row.name, row.category);
      via = 'llm';
      llmCalls++;
    }

    const current = row.subcategory ?? null;
    if (inferred === current) {
      sameCount++;
      continue;
    }

    changes.push({
      barcode: row.barcode,
      name: row.name,
      category: row.category,
      from: current,
      to: inferred,
      via,
    });

    if (!dryRun) {
      await db
        .update(products)
        .set({ subcategory: inferred })
        .where(eq(products.id, row.id));
    }

    // Lightweight progress ping every 25 rows so long runs don't look stuck.
    if ((i + 1) % 25 === 0) {
      console.log(
        `  progress: ${i + 1}/${rows.length} (${changes.length} changes so far, ${llmCalls} llm calls)`,
      );
    }
  }

  console.log(`\n═══ Changes (${changes.length}) ═══`);
  if (changes.length === 0) {
    console.log('  (none — inference is already in sync)');
  } else {
    for (const c of changes) {
      const arrow = `${c.from ?? '∅'} → ${c.to ?? '∅'}`;
      const tag = `[${c.via}]`.padEnd(10);
      console.log(
        `  ${tag} ${c.category.padEnd(10)} ${arrow.padEnd(28)} ${c.barcode}  ${c.name}`,
      );
    }
  }

  const added = changes.filter((c) => c.from === null && c.to !== null).length;
  const removed = changes.filter((c) => c.from !== null && c.to === null).length;
  const retargeted = changes.filter(
    (c) => c.from !== null && c.to !== null && c.from !== c.to,
  ).length;
  const viaLlm = changes.filter((c) => c.via === 'llm').length;

  console.log('\n═══ Summary ═══');
  console.log(`  total rows:       ${rows.length}`);
  console.log(`  already correct:  ${sameCount}`);
  console.log(`  newly assigned:   ${added}`);
  console.log(`  retargeted:       ${retargeted}`);
  console.log(`  cleared to null:  ${removed}`);
  console.log(`  llm calls used:   ${llmCalls}  (${viaLlm} produced changes)`);
  if (dryRun) {
    console.log('\n  (dry run — nothing was written)');
  }

  await closeDb();
}

main().catch((err) => {
  console.error('Backfill failed:', err);
  closeDb().finally(() => process.exit(1));
});

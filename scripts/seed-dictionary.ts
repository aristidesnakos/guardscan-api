/**
 * One-off script to upsert all seed dictionary entries into the
 * `ingredient_dictionary` Postgres table.
 *
 * Usage:
 *   npx tsx scripts/seed-dictionary.ts          # reads .env automatically
 *   DATABASE_URL=... npx tsx scripts/seed-dictionary.ts
 *
 * Safe to re-run — uses upsert (ON CONFLICT DO UPDATE).
 */

import { readFileSync } from 'fs';
import { resolve } from 'path';

// Load .env if present (Next.js auto-loads it, but raw tsx doesn't)
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

import { sql } from 'drizzle-orm';
import { getDb, closeDb } from '../db/client';
import { ingredientDictionary } from '../db/schema';
import { SEED_ENTRIES } from '../lib/dictionary/seed';

async function main() {
  console.log(`Seeding ${SEED_ENTRIES.length} dictionary entries...`);

  const db = getDb();
  let upserted = 0;

  // Process in batches of 50
  const batchSize = 50;
  for (let i = 0; i < SEED_ENTRIES.length; i += batchSize) {
    const batch = SEED_ENTRIES.slice(i, i + batchSize);

    const rows = batch.map((entry) => ({
      normalized: entry.normalized,
      displayName: entry.aliases[0] ?? entry.normalized,
      flag: entry.flag,
      category: entry.category === 'both' ? null : entry.category,
      evidenceUrl: entry.evidence_url,
      notes: entry.reason,
      fertilityRelevant: entry.fertility_relevant,
      testosteroneRelevant: entry.testosterone_relevant,
      ingredientGroup: entry.ingredient_group,
      healthRiskTags: entry.health_risk_tags,
    }));

    await db
      .insert(ingredientDictionary)
      .values(rows)
      .onConflictDoUpdate({
        target: ingredientDictionary.normalized,
        set: {
          displayName: sql`excluded.display_name`,
          flag: sql`excluded.flag`,
          category: sql`excluded.category`,
          evidenceUrl: sql`excluded.evidence_url`,
          notes: sql`excluded.notes`,
          fertilityRelevant: sql`excluded.fertility_relevant`,
          testosteroneRelevant: sql`excluded.testosterone_relevant`,
          ingredientGroup: sql`excluded.ingredient_group`,
          healthRiskTags: sql`excluded.health_risk_tags`,
        },
      });

    upserted += batch.length;
    console.log(`  ${upserted}/${SEED_ENTRIES.length} entries processed`);
  }

  console.log(`Done. ${upserted} entries upserted into ingredient_dictionary.`);
  await closeDb();
}

main().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});

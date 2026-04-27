#!/usr/bin/env npx tsx
/**
 * Delete all profiles where age is NULL.
 * Usage: npm run db:cleanup:null-ages
 *
 * This removes test/incomplete profiles that don't have meaningful interaction history.
 */
import { getDb, closeDb } from '@/db/client';
import { profiles } from '@/db/schema';
import { isNull } from 'drizzle-orm';

async function cleanup() {
  try {
    console.log('🧹 Deleting profiles with age = NULL...');

    const db = getDb();
    const result = await db.delete(profiles).where(isNull(profiles.age)).returning({ id: profiles.id });

    console.log(`✅ Deleted ${result.length} profiles`);
    await closeDb();
    process.exit(0);
  } catch (err) {
    console.error('❌ Error:', err instanceof Error ? err.message : err);
    process.exit(1);
  }
}

cleanup();

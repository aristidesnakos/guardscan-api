/**
 * Lazy Drizzle client.
 *
 * M1 runs without a provisioned database — the scan route short-circuits straight
 * through to Open Food Facts. The client is only constructed when a caller first
 * touches it, and we throw a readable error if DATABASE_URL is absent so missing
 * config surfaces at the call site instead of at import time.
 */

import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema';

export type Database = ReturnType<typeof drizzle<typeof schema>>;

let _db: Database | null = null;
let _sql: ReturnType<typeof postgres> | null = null;

export function isDatabaseConfigured(): boolean {
  return Boolean(process.env.DATABASE_URL);
}

export function getDb(): Database {
  if (_db) return _db;

  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      'DATABASE_URL is not set. The scan route tolerates this in M1 (it returns the OFF ' +
        'payload directly), but any call to getDb() requires Postgres. Set DATABASE_URL ' +
        'via `vercel env pull .env.local` or export it locally.',
    );
  }

  _sql = postgres(url, {
    // Neon/Supabase serverless pools accept a modest ceiling; Fluid Compute reuses
    // instances so we keep connections around rather than reopening per request.
    max: 5,
    idle_timeout: 20,
    prepare: false,
  });
  _db = drizzle(_sql, { schema });
  return _db;
}

/** Testing / graceful shutdown hook. Not used in the Vercel runtime. */
export async function closeDb(): Promise<void> {
  if (_sql) {
    await _sql.end({ timeout: 5 });
    _sql = null;
    _db = null;
  }
}

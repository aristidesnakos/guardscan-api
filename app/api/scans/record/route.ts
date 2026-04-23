import { NextResponse } from 'next/server';
import { sql } from 'drizzle-orm';

import { requireUser } from '@/lib/auth';
import { getDb } from '@/db/client';
import { profiles } from '@/db/schema';

const FREE_SCANS_TOTAL = parseInt(process.env.FREE_SCANS_TOTAL ?? '5', 10);

/**
 * POST /api/scans/record
 *
 * Atomically increments the authenticated user's total lifetime scan count.
 * Creates a profile row if one doesn't exist yet.
 * Response: { count: number, limit: number }
 */
export async function POST(request: Request) {
  const auth = await requireUser(request);
  if (auth instanceof NextResponse) return auth;

  const userId = auth.userId;
  if (!userId) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  try {
    const db = getDb();
    const [row] = await db
      .insert(profiles)
      .values({ userId, scanCount: 1 })
      .onConflictDoUpdate({
        target: profiles.userId,
        set: {
          scanCount: sql`${profiles.scanCount} + 1`,
          updatedAt: sql`now()`,
        },
      })
      .returning({ scanCount: profiles.scanCount });

    return NextResponse.json({
      count: row.scanCount,
      limit: FREE_SCANS_TOTAL,
    });
  } catch (err) {
    return NextResponse.json(
      { error: 'internal_error', detail: String(err) },
      { status: 500 },
    );
  }
}

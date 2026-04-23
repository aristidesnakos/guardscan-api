import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';

import { requireUser } from '@/lib/auth';
import { getDb } from '@/db/client';
import { profiles } from '@/db/schema';

const FREE_SCANS_TOTAL = parseInt(process.env.FREE_SCANS_TOTAL ?? '5', 10);

/**
 * GET /api/scans/daily-count
 *
 * Returns the authenticated user's total lifetime scan count.
 * Response: { count: number, limit: number }
 */
export async function GET(request: Request) {
  const auth = await requireUser(request);
  if (auth instanceof NextResponse) return auth;

  const userId = auth.userId;
  if (!userId) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  try {
    const db = getDb();
    const [row] = await db
      .select({ scanCount: profiles.scanCount })
      .from(profiles)
      .where(eq(profiles.userId, userId))
      .limit(1);

    return NextResponse.json({
      count: row?.scanCount ?? 0,
      limit: FREE_SCANS_TOTAL,
    });
  } catch (err) {
    return NextResponse.json(
      { error: 'internal_error', detail: String(err) },
      { status: 500 },
    );
  }
}

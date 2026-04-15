import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';

import { requireAdmin } from '@/lib/auth';
import { getDb } from '@/db/client';
import { userSubmissions } from '@/db/schema';

const BLOCKED = NextResponse.json({ error: 'not_available' }, { status: 404 });

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  if (process.env.NODE_ENV === 'production') return BLOCKED;

  const auth = await requireAdmin(request);
  if (auth instanceof NextResponse) return auth;

  const { id } = await params;

  let body: { reason?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }

  if (!body.reason || typeof body.reason !== 'string' || !body.reason.trim()) {
    return NextResponse.json({ error: 'reason_required' }, { status: 400 });
  }

  try {
    const db = getDb();

    const [row] = await db
      .select({ id: userSubmissions.id, status: userSubmissions.status })
      .from(userSubmissions)
      .where(eq(userSubmissions.id, id))
      .limit(1);

    if (!row) {
      return NextResponse.json({ error: 'not_found' }, { status: 404 });
    }

    if (row.status === 'published') {
      return NextResponse.json(
        { error: 'already_published' },
        { status: 409 },
      );
    }

    await db
      .update(userSubmissions)
      .set({ status: 'rejected', reviewedBy: auth.userId ?? 'admin' })
      .where(eq(userSubmissions.id, id));

    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json(
      { error: 'internal_error', detail: String(err) },
      { status: 500 },
    );
  }
}

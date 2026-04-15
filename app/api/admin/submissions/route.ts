import { NextResponse } from 'next/server';
import { eq, count, asc } from 'drizzle-orm';

import { requireAdmin } from '@/lib/auth';
import { getDb } from '@/db/client';
import { userSubmissions } from '@/db/schema';

const BLOCKED = NextResponse.json({ error: 'not_available' }, { status: 404 });

export async function GET(request: Request) {
  if (process.env.NODE_ENV === 'production') return BLOCKED;

  const auth = await requireAdmin(request);
  if (auth instanceof NextResponse) return auth;

  const url = new URL(request.url);
  const status = url.searchParams.get('status') || 'pending';
  const limit = Math.min(Number(url.searchParams.get('limit')) || 50, 100);
  const offset = Number(url.searchParams.get('offset')) || 0;

  try {
    const db = getDb();

    const validStatuses = ['pending', 'in_review', 'published', 'rejected'] as const;
    const statusFilter =
      status === 'all'
        ? undefined
        : validStatuses.includes(status as (typeof validStatuses)[number])
          ? (status as (typeof validStatuses)[number])
          : 'pending';

    const baseQuery = statusFilter
      ? db.select().from(userSubmissions).where(eq(userSubmissions.status, statusFilter))
      : db.select().from(userSubmissions);

    const rows = await baseQuery
      .orderBy(asc(userSubmissions.createdAt))
      .limit(limit)
      .offset(offset);

    const [totalRow] = statusFilter
      ? await db
          .select({ total: count() })
          .from(userSubmissions)
          .where(eq(userSubmissions.status, statusFilter))
      : await db.select({ total: count() }).from(userSubmissions);

    const submissions = rows.map((row) => {
      const ocr = row.ocrText
        ? (JSON.parse(row.ocrText) as { confidence?: number })
        : null;
      return {
        id: row.id,
        barcode: row.barcode,
        status: row.status,
        confidence: ocr?.confidence ?? null,
        createdAt: row.createdAt.toISOString(),
        hasOcr: !!row.ocrText,
      };
    });

    return NextResponse.json({
      submissions,
      total: totalRow.total,
      limit,
      offset,
    });
  } catch (err) {
    return NextResponse.json(
      { error: 'internal_error', detail: String(err) },
      { status: 500 },
    );
  }
}

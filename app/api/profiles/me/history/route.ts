import { NextResponse } from 'next/server';
import { sql } from 'drizzle-orm';

import { requireUser } from '@/lib/auth';
import { getDb, isDatabaseConfigured } from '@/db/client';
import { getRating } from '@/lib/scoring/constants';
import type { ScanHistoryItem, Product } from '@/types/guardscan';

export async function GET(request: Request) {
  const auth = await requireUser(request);
  if (auth instanceof NextResponse) return auth;

  if (!auth.userId || !isDatabaseConfigured()) {
    return NextResponse.json({ data: [], total: 0, limit: 20, offset: 0 });
  }

  const url = new URL(request.url);
  const limit = Math.min(Number(url.searchParams.get('limit') ?? 50), 100);
  const offset = Number(url.searchParams.get('offset') ?? 0);

  const db = getDb();

  // One row per scanned product, keyed by the newest scan_event for that
  // product. Implemented as DISTINCT ON (product_id) so users who rescan the
  // same product don't see duplicate history entries. The outer query then
  // re-orders the deduped set by scan recency for pagination.
  const rows = await db.execute(sql`
    SELECT
      dedupe.event_id,
      dedupe.scanned_at,
      p.id AS product_id,
      p.barcode,
      p.name,
      p.brand,
      p.category,
      p.subcategory,
      p.image_front,
      p.source,
      p.score,
      p.created_at,
      p.last_synced_at
    FROM (
      SELECT DISTINCT ON (se.product_id)
        se.id AS event_id,
        se.product_id,
        se.scanned_at
      FROM scan_events se
      WHERE se.user_id = ${auth.userId}
      ORDER BY se.product_id, se.scanned_at DESC
    ) dedupe
    INNER JOIN products p ON p.id = dedupe.product_id
    ORDER BY dedupe.scanned_at DESC
    LIMIT ${limit}
    OFFSET ${offset}
  `);

  // `total` counts distinct products the user has scanned so that `data` and
  // `total` speak the same unit (pagination over deduped rows).
  const countRows = await db.execute(sql`
    SELECT COUNT(DISTINCT product_id)::int AS count
    FROM scan_events
    WHERE user_id = ${auth.userId}
  `);
  const total = Number((countRows[0] as { count: number | string } | undefined)?.count ?? 0);

  const data: ScanHistoryItem[] = (rows as Record<string, unknown>[]).map((row) => {
    const scoreVal = (row.score as number | null) ?? null;
    const rating = scoreVal != null ? getRating(scoreVal).label : null;

    const product: Product = {
      id: row.product_id as string,
      barcode: row.barcode as string,
      name: row.name as string,
      brand: (row.brand as string) ?? '',
      category: row.category as Product['category'],
      subcategory: (row.subcategory as string) ?? null,
      image_url: (row.image_front as string) ?? null,
      data_completeness: 'full',
      ingredient_source: row.source === 'dsld' ? 'verified' : 'open_food_facts',
      ingredients: [], // Omit ingredients in list view for payload size
      created_at: new Date(row.created_at as string | Date).toISOString(),
      updated_at: new Date(row.last_synced_at as string | Date).toISOString(),
    };

    return {
      id: row.event_id as string,
      product,
      score: scoreVal,
      rating,
      scanned_at: new Date(row.scanned_at as string | Date).toISOString(),
      is_favorite: false, // Favorites not yet implemented
    };
  });

  return NextResponse.json({ data, total, limit, offset });
}

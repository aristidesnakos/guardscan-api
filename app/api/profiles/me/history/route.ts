import { NextResponse } from 'next/server';
import { eq, desc, sql } from 'drizzle-orm';

import { requireUser } from '@/lib/auth';
import { getDb, isDatabaseConfigured } from '@/db/client';
import { scanEvents, products } from '@/db/schema';
import { getRating } from '@/lib/scoring/constants';
import type { ScanHistoryItem, Product } from '@/types/guardscan';

export async function GET(request: Request) {
  const auth = requireUser(request);
  if (auth instanceof NextResponse) return auth;

  if (!auth.userId || !isDatabaseConfigured()) {
    return NextResponse.json({ data: [], total: 0, limit: 20, offset: 0 });
  }

  const url = new URL(request.url);
  const limit = Math.min(Number(url.searchParams.get('limit') ?? 50), 100);
  const offset = Number(url.searchParams.get('offset') ?? 0);

  const db = getDb();

  // Deduplicate: show only the latest scan per product
  const rows = await db
    .select({
      eventId: scanEvents.id,
      scannedAt: scanEvents.scannedAt,
      productId: products.id,
      barcode: products.barcode,
      name: products.name,
      brand: products.brand,
      category: products.category,
      subcategory: products.subcategory,
      imageFront: products.imageFront,
      source: products.source,
      score: products.score,
      scoreBreakdown: products.scoreBreakdown,
      createdAt: products.createdAt,
      lastSyncedAt: products.lastSyncedAt,
    })
    .from(scanEvents)
    .innerJoin(products, eq(scanEvents.productId, products.id))
    .where(eq(scanEvents.userId, auth.userId))
    .orderBy(desc(scanEvents.scannedAt))
    .limit(limit)
    .offset(offset);

  // Count total distinct products scanned by this user
  const [{ count }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(scanEvents)
    .where(eq(scanEvents.userId, auth.userId));

  const data: ScanHistoryItem[] = rows.map((row) => {
    const scoreVal = row.score ?? null;
    const rating = scoreVal != null ? getRating(scoreVal).label : null;

    const product: Product = {
      id: row.productId,
      barcode: row.barcode,
      name: row.name,
      brand: row.brand ?? '',
      category: row.category as Product['category'],
      subcategory: row.subcategory ?? null,
      image_url: row.imageFront ?? null,
      data_completeness: 'full',
      ingredient_source: row.source === 'dsld' ? 'verified' : 'open_food_facts',
      ingredients: [], // Omit ingredients in list view for payload size
      created_at: row.createdAt.toISOString(),
      updated_at: row.lastSyncedAt.toISOString(),
    };

    return {
      id: row.eventId,
      product,
      score: scoreVal,
      rating,
      scanned_at: row.scannedAt.toISOString(),
      is_favorite: false, // Favorites not yet implemented
    };
  });

  return NextResponse.json({ data, total: count, limit, offset });
}

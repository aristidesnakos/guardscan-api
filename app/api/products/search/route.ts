import { NextResponse } from 'next/server';
import { and, asc, eq, gte, ilike, inArray, or, sql } from 'drizzle-orm';

import type { PaginatedResponse, Product } from '@/types/guardscan';
import { requireUser } from '@/lib/auth';
import { getDb, isDatabaseConfigured } from '@/db/client';
import { productIngredients, products } from '@/db/schema';
import { log } from '@/lib/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;
const VALID_CATEGORIES = new Set(['food', 'grooming', 'supplement']);
const VALID_SORT = new Set(['relevance', 'best_rated']);

export async function POST(request: Request) {
  log.debug('search_request', { method: 'POST', path: '/api/products/search' });

  const auth = await requireUser(request);
  if (auth instanceof NextResponse) return auth;

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }

  const {
    query = '',
    category,
    subcategory,
    min_score,
    sort_by = 'relevance',
    limit: rawLimit = DEFAULT_LIMIT,
    offset: rawOffset = 0,
  } = body;

  // Validation
  if (typeof query !== 'string') {
    return NextResponse.json({ error: 'query must be a string' }, { status: 400 });
  }
  if (category !== undefined && !VALID_CATEGORIES.has(category as string)) {
    return NextResponse.json({ error: 'invalid category' }, { status: 400 });
  }
  if (sort_by !== undefined && !VALID_SORT.has(sort_by as string)) {
    return NextResponse.json({ error: 'invalid sort_by' }, { status: 400 });
  }
  if (
    subcategory !== undefined &&
    (typeof subcategory !== 'string' || subcategory.length > 80)
  ) {
    return NextResponse.json({ error: 'invalid subcategory' }, { status: 400 });
  }

  const limit = Math.min(Math.max(1, Number(rawLimit) || DEFAULT_LIMIT), MAX_LIMIT);
  const offset = Math.max(0, Number(rawOffset) || 0);

  if (!isDatabaseConfigured()) {
    const empty: PaginatedResponse<Product> = { data: [], total: 0, limit, offset };
    return NextResponse.json(empty);
  }

  const db = getDb();
  const pattern = `%${query}%`;
  const useTextFilter = query.length >= 2;

  // Build WHERE conditions
  const conditions = [];

  if (useTextFilter) {
    conditions.push(or(ilike(products.name, pattern), ilike(products.brand, pattern))!);
  }
  if (category) {
    conditions.push(eq(products.category, category as 'food' | 'grooming' | 'supplement'));
  }
  if (subcategory) {
    conditions.push(eq(products.subcategory, subcategory as string));
  }
  if (min_score != null && !Number.isNaN(Number(min_score))) {
    conditions.push(gte(products.score, Number(min_score)));
  }

  const where = conditions.length > 0 ? and(...conditions) : undefined;

  // Build ORDER BY
  // Use raw sql expressions so we can specify NULLS LAST and the relevance CASE.
  const orderClauses =
    sort_by === 'best_rated'
      ? [sql`score DESC NULLS LAST`, asc(products.name)]
      : useTextFilter
        ? [
            sql`CASE WHEN name ILIKE ${pattern} THEN 0 ELSE 1 END ASC`,
            sql`score DESC NULLS LAST`,
            asc(products.name),
          ]
        : [sql`score DESC NULLS LAST`, asc(products.name)];

  // Execute main query + count in parallel
  let rows: (typeof products.$inferSelect)[];
  let countResult: { count: number }[];
  try {
    [rows, countResult] = await Promise.all([
      db
        .select()
        .from(products)
        .where(where)
        .orderBy(...orderClauses)
        .limit(limit)
        .offset(offset),
      db
        .select({ count: sql<number>`count(*)::int` })
        .from(products)
        .where(where),
    ]);
  } catch (err) {
    log.error('search_db_error', { error: String(err), query: query.slice(0, 50), category });
    return NextResponse.json({ error: 'internal_error' }, { status: 500 });
  }

  const total = countResult[0]?.count ?? 0;

  // Batch-fetch ingredients for all results in one query (avoids N+1)
  const productIds = rows.map((r) => r.id);
  const allIngredients =
    productIds.length > 0
      ? await db
          .select()
          .from(productIngredients)
          .where(inArray(productIngredients.productId, productIds))
      : [];

  // Group by product ID
  const ingsByProduct = new Map<string, typeof allIngredients>();
  for (const ing of allIngredients) {
    const list = ingsByProduct.get(ing.productId) ?? [];
    list.push(ing);
    ingsByProduct.set(ing.productId, list);
  }

  const data: Product[] = rows.map((row) => {
    const ings = ingsByProduct.get(row.id) ?? [];
    return {
      id: row.id,
      barcode: row.barcode,
      name: row.name,
      brand: row.brand ?? '',
      category: row.category as Product['category'],
      subcategory: row.subcategory ?? null,
      image_url: row.imageFront ?? null,
      data_completeness: 'full',
      ingredient_source: row.source === 'dsld' ? 'verified' : 'open_food_facts',
      ingredients: ings.map((ing) => ({
        name: ing.name,
        position: ing.position,
        flag: (ing.flag ?? 'neutral') as Product['ingredients'][number]['flag'],
        reason: ing.reason ?? '',
        fertility_relevant: false,
        testosterone_relevant: false,
      })),
      created_at: row.createdAt.toISOString(),
      updated_at: row.lastSyncedAt.toISOString(),
    };
  });

  log.info('search_ok', {
    query: query.slice(0, 50),
    category,
    subcategory,
    sort_by,
    total,
    returned: data.length,
    offset,
  });

  return NextResponse.json<PaginatedResponse<Product>>({ data, total, limit, offset });
}

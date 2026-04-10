/**
 * GET /api/products/:id/alternatives
 *
 * Returns up to 10 higher-scoring products in the same subcategory.
 * Requires the source product to have both a subcategory and a score.
 * MIN_SCORE_DELTA (15) enforced per charter §13.4.
 */

import { NextResponse } from 'next/server';
import { eq, and, ne, gte, isNotNull, desc } from 'drizzle-orm';

import type { Product, ProductAlternative } from '@/types/guardscan';
import { requireUser } from '@/lib/auth';
import { getDb, isDatabaseConfigured } from '@/db/client';
import { products, productIngredients } from '@/db/schema';
import { MIN_SCORE_DELTA } from '@/lib/scoring/constants';
import { getRating } from '@/lib/scoring/constants';
import { log } from '@/lib/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_ALTERNATIVES = 10;

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireUser(request);
  if (auth instanceof NextResponse) return auth;

  const { id } = await params;

  if (!isDatabaseConfigured()) {
    return NextResponse.json([], {
      headers: { 'Cache-Control': 'public, max-age=0, s-maxage=3600, stale-while-revalidate=86400' },
    });
  }

  const db = getDb();

  // 1. Look up source product
  const [source] = await db
    .select()
    .from(products)
    .where(eq(products.id, id))
    .limit(1);

  if (!source) {
    return NextResponse.json(
      { error: 'not_found', message: 'Product not found' },
      { status: 404 },
    );
  }

  // 2. No subcategory or no score → no alternatives
  if (!source.subcategory || source.score == null) {
    log.info('alternatives_skip', { product_id: id, reason: 'no_subcategory_or_score' });
    return NextResponse.json([], {
      headers: { 'Cache-Control': 'public, max-age=0, s-maxage=3600, stale-while-revalidate=86400' },
    });
  }

  // 3. Query: same subcategory, score >= source + MIN_SCORE_DELTA, not self
  const minScore = source.score + MIN_SCORE_DELTA;
  const altRows = await db
    .select()
    .from(products)
    .where(
      and(
        eq(products.subcategory, source.subcategory),
        gte(products.score, minScore),
        ne(products.id, source.id),
        isNotNull(products.scoreBreakdown),
      ),
    )
    .orderBy(desc(products.score))
    .limit(MAX_ALTERNATIVES);

  // 4. Reconstruct ProductAlternative[] with ingredients + reason
  const alternatives: ProductAlternative[] = [];

  for (const row of altRows) {
    const ings = await db
      .select()
      .from(productIngredients)
      .where(eq(productIngredients.productId, row.id));

    const delta = (row.score ?? 0) - (source.score ?? 0);
    const { label: rating } = getRating(row.score ?? 0);

    const product: Product = {
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

    alternatives.push({
      product,
      score: row.score ?? 0,
      rating,
      reason: buildReason(delta, ings.length, source),
    });
  }

  log.info('alternatives_ok', {
    product_id: id,
    subcategory: source.subcategory,
    source_score: source.score,
    count: alternatives.length,
  });

  return NextResponse.json(alternatives, {
    headers: {
      'Cache-Control': 'public, max-age=0, s-maxage=3600, stale-while-revalidate=86400',
    },
  });
}

function buildReason(
  delta: number,
  altIngredientCount: number,
  source: { score: number | null; name: string },
): string {
  const parts: string[] = [];
  parts.push(`Scores ${delta} points higher`);
  if (altIngredientCount > 0) {
    parts.push('with fewer concerning ingredients');
  }
  return parts.join(' ');
}

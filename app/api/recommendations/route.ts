/**
 * GET /api/recommendations?category=<optional>
 *
 * Returns up to 20 RecommendationPair objects for the authenticated user.
 * Each pair: a Poor/Mediocre scanned product + its single best alternative
 * in the same subcategory (score delta >= MIN_SCORE_DELTA).
 *
 * Powered by scan_events — users only see recommendations for products
 * they've actually scanned.
 */

import { NextResponse } from 'next/server';
import { sql, asc } from 'drizzle-orm';

import type {
  Product,
  ProductCategory,
  RecommendationPair,
  ProductAlternative,
} from '@/types/guardscan';
import { hydrateIngredient } from '@/lib/dictionary/resolve';
import { requireUser } from '@/lib/auth';
import { getDb, isDatabaseConfigured } from '@/db/client';
import { products, productIngredients, scanEvents } from '@/db/schema';
import { MIN_SCORE_DELTA } from '@/lib/scoring/constants';
import { getRating } from '@/lib/scoring/constants';
import { log } from '@/lib/logger';
import { eq } from 'drizzle-orm';
import { resolveImageUrl } from '@/lib/storage/supabase';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_PAIRS = 20;
const POOR_MEDIOCRE_THRESHOLD = 60;

const VALID_CATEGORIES: ProductCategory[] = ['food', 'grooming', 'supplement'];

export async function GET(request: Request) {
  const auth = await requireUser(request);
  if (auth instanceof NextResponse) return auth;

  if (!auth.userId) {
    return NextResponse.json(
      { error: 'unauthorized', message: 'User ID required for recommendations' },
      { status: 401 },
    );
  }

  if (!isDatabaseConfigured()) {
    return NextResponse.json([]);
  }

  const db = getDb();
  const url = new URL(request.url);
  const categoryParam = url.searchParams.get('category');
  const categoryFilter =
    categoryParam && (VALID_CATEGORIES as string[]).includes(categoryParam)
      ? categoryParam
      : null;

  try {
    // CTE query: find user's Poor/Mediocre scans, then for each find the best alternative
    const categoryClause = categoryFilter
      ? sql`AND p.category = ${categoryFilter}`
      : sql``;

    const rows = await db.execute(sql`
      WITH user_scans AS (
        SELECT DISTINCT ON (se.product_id)
          se.product_id,
          se.scanned_at,
          p.name AS product_name,
          p.barcode,
          p.brand,
          p.category,
          p.subcategory,
          p.image_front,
          p.source,
          p.score,
          p.score_breakdown,
          p.created_at,
          p.last_synced_at
        FROM scan_events se
        JOIN products p ON p.id = se.product_id
        WHERE se.user_id = ${auth.userId}
          AND p.score IS NOT NULL
          AND p.score < ${POOR_MEDIOCRE_THRESHOLD}
          AND p.subcategory IS NOT NULL
          ${categoryClause}
        ORDER BY se.product_id, se.scanned_at DESC
      ),
      best_alternatives AS (
        SELECT DISTINCT ON (us.product_id)
          us.product_id AS scanned_product_id,
          us.scanned_at,
          alt.id AS alt_id,
          alt.name AS alt_name,
          alt.barcode AS alt_barcode,
          alt.brand AS alt_brand,
          alt.category AS alt_category,
          alt.subcategory AS alt_subcategory,
          alt.image_front AS alt_image_front,
          alt.source AS alt_source,
          alt.score AS alt_score,
          alt.created_at AS alt_created_at,
          alt.last_synced_at AS alt_last_synced_at
        FROM user_scans us
        JOIN products alt ON alt.subcategory = us.subcategory
          AND alt.id != us.product_id
          AND alt.score >= us.score + ${MIN_SCORE_DELTA}
          AND alt.score_breakdown IS NOT NULL
        ORDER BY us.product_id, alt.score DESC
      )
      SELECT
        us.*,
        ba.alt_id,
        ba.alt_name,
        ba.alt_barcode,
        ba.alt_brand,
        ba.alt_category,
        ba.alt_subcategory,
        ba.alt_image_front,
        ba.alt_source,
        ba.alt_score,
        ba.alt_created_at,
        ba.alt_last_synced_at
      FROM user_scans us
      JOIN best_alternatives ba ON ba.scanned_product_id = us.product_id
      ORDER BY us.scanned_at DESC
      LIMIT ${MAX_PAIRS}
    `);

    // Build RecommendationPair[] from raw rows
    const pairs: RecommendationPair[] = [];

    for (const row of rows) {
      const r = row as Record<string, unknown>;

      // Fetch ingredients for both products
      const [scannedIngs, altIngs] = await Promise.all([
        db.select().from(productIngredients).where(eq(productIngredients.productId, r.product_id as string)).orderBy(asc(productIngredients.position)),
        db.select().from(productIngredients).where(eq(productIngredients.productId, r.alt_id as string)).orderBy(asc(productIngredients.position)),
      ]);

      const scannedScore = r.score as number;
      const altScore = r.alt_score as number;
      const delta = altScore - scannedScore;
      const { label: scannedRating } = getRating(scannedScore);
      const { label: altRating } = getRating(altScore);

      const scannedProduct: Product = {
        id: r.product_id as string,
        barcode: r.barcode as string,
        name: r.product_name as string,
        brand: (r.brand as string) ?? '',
        category: r.category as Product['category'],
        subcategory: (r.subcategory as string) ?? null,
        image_url: resolveImageUrl((r.image_front as string) ?? null),
        data_completeness: 'full',
        ingredient_source: r.source === 'dsld' ? 'verified' : 'open_food_facts',
        ingredients: scannedIngs.map((ing) => hydrateIngredient(ing, r.category as ProductCategory)),
        created_at: String(r.created_at),
        updated_at: String(r.last_synced_at),
      };

      const altProduct: Product = {
        id: r.alt_id as string,
        barcode: r.alt_barcode as string,
        name: r.alt_name as string,
        brand: (r.alt_brand as string) ?? '',
        category: r.alt_category as Product['category'],
        subcategory: (r.alt_subcategory as string) ?? null,
        image_url: resolveImageUrl((r.alt_image_front as string) ?? null),
        data_completeness: 'full',
        ingredient_source: r.alt_source === 'dsld' ? 'verified' : 'open_food_facts',
        ingredients: altIngs.map((ing) => hydrateIngredient(ing, r.alt_category as ProductCategory)),
        created_at: String(r.alt_created_at),
        updated_at: String(r.alt_last_synced_at),
      };

      const alternative: ProductAlternative = {
        product: altProduct,
        score: altScore,
        rating: altRating,
        reason: `Scores ${delta} points higher with fewer concerning ingredients`,
      };

      pairs.push({
        scanned: {
          product: scannedProduct,
          score: scannedScore,
          rating: scannedRating,
          scanned_at: String(r.scanned_at),
        },
        alternative,
        subcategory_hint: (r.subcategory as string) ?? undefined,
      });
    }

    log.info('recommendations_ok', {
      user_id: auth.userId,
      category_filter: categoryFilter,
      pair_count: pairs.length,
    });

    return NextResponse.json(pairs);
  } catch (err) {
    log.error('recommendations_failed', {
      user_id: auth.userId,
      error: String(err),
    });
    return NextResponse.json(
      { error: 'recommendations_failed' },
      { status: 500 },
    );
  }
}

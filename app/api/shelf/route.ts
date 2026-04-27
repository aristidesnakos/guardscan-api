/**
 * GET  /api/shelf — fetch user's shelf with stats
 * POST /api/shelf — add one or more products to shelf (single-add returns swap_candidates)
 *
 * See docs/milestones/m4-shelf.md for full semantics.
 */

import { NextResponse } from 'next/server';
import { sql } from 'drizzle-orm';

import { requireUser } from '@/lib/auth';
import { getDb, isDatabaseConfigured } from '@/db/client';
import { resolveImageUrl } from '@/lib/storage/supabase';
import { log } from '@/lib/logger';
import type {
  AddToShelfRequest,
  AddToShelfResponse,
  ProductCategory,
  ShelfItem,
  ShelfResponse,
  SwapCandidate,
} from '@/types/guardscan';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const VALID_CATEGORIES: ProductCategory[] = ['food', 'grooming', 'supplement'];
// FE hides aggregate stats below this threshold to avoid noisy 0/1/2 numbers
// against partial catalog scoring coverage. Mirrored in
// cucumberdude/docs/product/FEATURES/SHELF.md.
const MIN_SCORED_ITEMS_FOR_STATS = 3;
const MAX_BULK_ADD = 100;

// ── GET ─────────────────────────────────────────────────────────────────────

export async function GET(request: Request) {
  const auth = await requireUser(request);
  if (auth instanceof NextResponse) return auth;

  if (!auth.userId) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  if (!isDatabaseConfigured()) {
    const empty: ShelfResponse = {
      items: [],
      stats: {
        total_count: 0,
        average_score: null,
        upgrades_available: 0,
        upgrade_product_ids: [],
        scored_item_count: 0,
      },
    };
    return NextResponse.json(empty);
  }

  const url = new URL(request.url);
  const categoryParam = url.searchParams.get('category');
  const sortParam = url.searchParams.get('sort') ?? 'recent';

  const categoryFilter =
    categoryParam &&
    categoryParam !== 'all' &&
    (VALID_CATEGORIES as string[]).includes(categoryParam)
      ? (categoryParam as ProductCategory)
      : null;

  const orderBy = sortParam === 'alphabetical' ? sql`s.product_name ASC` : sql`s.scan_date DESC`;
  const categoryClause = categoryFilter
    ? sql`AND s.product_category = ${categoryFilter}`
    : sql``;

  const db = getDb();

  try {
    const itemRows = await db.execute(sql`
      SELECT
        s.id,
        s.product_id,
        s.product_name,
        s.product_brand,
        s.product_category,
        s.current_score,
        s.added_date,
        s.scan_date,
        s.swapped_from_id,
        p.image_front,
        sf.name AS swapped_from_name
      FROM shelf_items s
      JOIN products p ON p.id = s.product_id
      LEFT JOIN products sf ON sf.id = s.swapped_from_id
      WHERE s.user_id = ${auth.userId}
        ${categoryClause}
      ORDER BY ${orderBy}
    `);

    const items: ShelfItem[] = (itemRows as Record<string, unknown>[]).map((row) => ({
      id: row.id as string,
      product_id: row.product_id as string,
      product_name: row.product_name as string,
      product_brand: (row.product_brand as string) ?? '',
      product_category: row.product_category as ProductCategory,
      current_score: (row.current_score as number | null) ?? null,
      product_image_url: resolveImageUrl((row.image_front as string) ?? null),
      added_date: new Date(row.added_date as string | Date).toISOString(),
      scan_date: new Date(row.scan_date as string | Date).toISOString(),
      swapped_from_id: (row.swapped_from_id as string | null) ?? null,
      swapped_from_name: (row.swapped_from_name as string | null) ?? null,
    }));

    // Aggregate stats — single round-trip. Subcategory match for upgrade detection
    // (smallest meaningful matching unit, mirrors recommendations API). Spec wording
    // says "category" but the spirit is "comparable alternative" — see milestone doc.
    const statRows = await db.execute(sql`
      WITH shelf AS (
        SELECT s.id, s.product_id, s.current_score, p.subcategory
        FROM shelf_items s
        JOIN products p ON p.id = s.product_id
        WHERE s.user_id = ${auth.userId}
      )
      SELECT
        (SELECT COUNT(*)::int FROM shelf) AS total_count,
        (SELECT COUNT(*)::int FROM shelf WHERE current_score IS NOT NULL) AS scored_item_count,
        (SELECT AVG(current_score)::float FROM shelf WHERE current_score IS NOT NULL) AS average_score
    `);

    const stat = (statRows as Record<string, unknown>[])[0] ?? {};
    const scoredCount = Number(stat.scored_item_count ?? 0);
    const avgScoreRaw = stat.average_score as number | null;

    // Per-item upgrade detection — returns the product_ids that contribute to
    // upgrades_available so the FE can both render the count AND filter the
    // list to those items when the user taps the upgrade row.
    const upgradeRows = await db.execute(sql`
      SELECT s.product_id
      FROM shelf_items s
      JOIN products p ON p.id = s.product_id
      WHERE s.user_id = ${auth.userId}
        AND s.current_score IS NOT NULL
        AND p.subcategory IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM products alt
          WHERE alt.subcategory = p.subcategory
            AND alt.id <> s.product_id
            AND alt.score IS NOT NULL
            AND alt.score > s.current_score
        )
    `);
    const upgradeProductIds = (upgradeRows as Record<string, unknown>[]).map((r) =>
      String(r.product_id),
    );

    const response: ShelfResponse = {
      items,
      stats: {
        total_count: Number(stat.total_count ?? 0),
        scored_item_count: scoredCount,
        average_score:
          scoredCount >= MIN_SCORED_ITEMS_FOR_STATS && avgScoreRaw != null
            ? Math.round(avgScoreRaw)
            : null,
        upgrades_available: upgradeProductIds.length,
        upgrade_product_ids: upgradeProductIds,
      },
    };

    return NextResponse.json(response);
  } catch (err) {
    log.error('shelf_get_failed', { user_id: auth.userId, error: String(err) });
    return NextResponse.json({ error: 'shelf_fetch_failed' }, { status: 500 });
  }
}

// ── POST ────────────────────────────────────────────────────────────────────

export async function POST(request: Request) {
  const auth = await requireUser(request);
  if (auth instanceof NextResponse) return auth;

  if (!auth.userId) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  if (!isDatabaseConfigured()) {
    return NextResponse.json({ error: 'database_unavailable' }, { status: 503 });
  }

  let body: AddToShelfRequest;
  try {
    body = (await request.json()) as AddToShelfRequest;
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }

  const requestedIds = Array.isArray(body.product_ids) ? body.product_ids : [];
  if (requestedIds.length === 0) {
    return NextResponse.json({ error: 'product_ids_required' }, { status: 400 });
  }
  if (requestedIds.length > MAX_BULK_ADD) {
    return NextResponse.json(
      { error: 'too_many_products', max: MAX_BULK_ADD },
      { status: 400 },
    );
  }

  // Dedupe within the request itself
  const uniqueRequested = Array.from(new Set(requestedIds));
  const isSingleAdd = uniqueRequested.length === 1;

  const db = getDb();

  try {
    // Insert with ON CONFLICT DO NOTHING. Denormalized fields pulled from products in one shot.
    const insertedRows = await db.execute(sql`
      INSERT INTO shelf_items (
        user_id, product_id, product_name, product_brand, product_category, current_score
      )
      SELECT ${auth.userId}, p.id, p.name, COALESCE(p.brand, ''), p.category, p.score
      FROM products p
      WHERE p.id = ANY(${uniqueRequested}::uuid[])
      ON CONFLICT (user_id, product_id) DO NOTHING
      RETURNING product_id
    `);

    const addedSet = new Set(
      (insertedRows as Record<string, unknown>[]).map((r) => String(r.product_id)),
    );

    // Existing shelf rows in the requested set (excluding the just-added) — duplicates
    const existingRows = await db.execute(sql`
      SELECT product_id FROM shelf_items
      WHERE user_id = ${auth.userId}
        AND product_id = ANY(${uniqueRequested}::uuid[])
    `);
    const existingSet = new Set(
      (existingRows as Record<string, unknown>[]).map((r) => String(r.product_id)),
    );

    const added = uniqueRequested.filter((id) => addedSet.has(id));
    const duplicates = uniqueRequested.filter(
      (id) => !addedSet.has(id) && existingSet.has(id),
    );
    // Anything not added and not duplicate is an error (unknown product id, etc.)
    const errors = uniqueRequested.filter(
      (id) => !addedSet.has(id) && !existingSet.has(id),
    );

    let swap_candidates: AddToShelfResponse['swap_candidates'];

    // Swap candidates only on single-add path
    if (isSingleAdd && added.length === 1) {
      const addedId = added[0];

      const candidateRows = await db.execute(sql`
        SELECT
          s.id AS shelf_item_id,
          s.product_id,
          s.product_name,
          s.product_brand,
          s.current_score
        FROM shelf_items s
        JOIN products p_shelf ON p_shelf.id = s.product_id
        JOIN products p_added ON p_added.id = ${addedId}
        WHERE s.user_id = ${auth.userId}
          AND s.product_id <> ${addedId}
          AND s.current_score IS NOT NULL
          AND p_added.score IS NOT NULL
          AND s.current_score < p_added.score
          AND p_shelf.subcategory IS NOT NULL
          AND p_shelf.subcategory = p_added.subcategory
        ORDER BY s.current_score ASC
        LIMIT 5
      `);

      const candidates: SwapCandidate[] = (candidateRows as Record<string, unknown>[]).map(
        (row) => ({
          shelf_item_id: row.shelf_item_id as string,
          product_id: row.product_id as string,
          product_name: row.product_name as string,
          product_brand: (row.product_brand as string) ?? '',
          current_score: (row.current_score as number | null) ?? null,
        }),
      );

      // Only include the map when there are actual candidates — keeps the
      // FE branching simple (presence-of-key === show prompt).
      if (candidates.length > 0) {
        swap_candidates = { [addedId]: candidates };
      }
    }

    log.info('shelf_post_ok', {
      user_id: auth.userId,
      added_count: added.length,
      duplicate_count: duplicates.length,
      error_count: errors.length,
      swap_candidate_count: swap_candidates ? swap_candidates[added[0]]?.length ?? 0 : 0,
    });

    const response: AddToShelfResponse = {
      added,
      duplicates,
      errors,
      ...(swap_candidates ? { swap_candidates } : {}),
    };

    return NextResponse.json(response);
  } catch (err) {
    log.error('shelf_post_failed', { user_id: auth.userId, error: String(err) });
    return NextResponse.json({ error: 'shelf_add_failed' }, { status: 500 });
  }
}

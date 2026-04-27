/**
 * PUT    /api/shelf/:id — update a shelf item (limited fields; scan_date is NOT updatable here)
 * DELETE /api/shelf/:id — remove a shelf item, optionally linking the swap (Flow 4 in spec)
 *
 * See docs/milestones/m4-shelf.md for full semantics.
 */

import { NextResponse } from 'next/server';
import { sql } from 'drizzle-orm';

import { requireUser } from '@/lib/auth';
import { getDb, isDatabaseConfigured } from '@/db/client';
import { log } from '@/lib/logger';
import type {
  DeleteShelfRequest,
  DeleteShelfResponse,
  ProductCategory,
  UpdateShelfRequest,
} from '@/types/guardscan';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const VALID_CATEGORIES: ProductCategory[] = ['food', 'grooming', 'supplement'];

// ── PUT ─────────────────────────────────────────────────────────────────────

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireUser(request);
  if (auth instanceof NextResponse) return auth;

  if (!auth.userId) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  if (!isDatabaseConfigured()) {
    return NextResponse.json({ error: 'database_unavailable' }, { status: 503 });
  }

  const { id } = await params;

  let body: UpdateShelfRequest;
  try {
    body = (await request.json()) as UpdateShelfRequest;
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }

  if (
    body.product_category &&
    !(VALID_CATEGORIES as string[]).includes(body.product_category)
  ) {
    return NextResponse.json({ error: 'invalid_category' }, { status: 400 });
  }

  const db = getDb();

  try {
    const updateRows = await db.execute(sql`
      UPDATE shelf_items
      SET
        product_category = COALESCE(${body.product_category ?? null}, product_category),
        updated_at = now()
      WHERE id = ${id} AND user_id = ${auth.userId}
      RETURNING id
    `);

    if ((updateRows as unknown[]).length === 0) {
      return NextResponse.json({ error: 'not_found' }, { status: 404 });
    }

    return NextResponse.json({ updated: true });
  } catch (err) {
    log.error('shelf_put_failed', {
      user_id: auth.userId,
      shelf_item_id: id,
      error: String(err),
    });
    return NextResponse.json({ error: 'shelf_update_failed' }, { status: 500 });
  }
}

// ── DELETE ──────────────────────────────────────────────────────────────────

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireUser(request);
  if (auth instanceof NextResponse) return auth;

  if (!auth.userId) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  if (!isDatabaseConfigured()) {
    return NextResponse.json({ error: 'database_unavailable' }, { status: 503 });
  }

  const { id } = await params;

  // DELETE accepts a body with optional swap_link_to_product_id. Body is allowed
  // for DELETE per RFC 9110; we tolerate empty/missing bodies.
  let body: DeleteShelfRequest = {};
  try {
    const text = await request.text();
    if (text.trim().length > 0) {
      body = JSON.parse(text) as DeleteShelfRequest;
    }
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }

  const swapLinkToProductId = body.swap_link_to_product_id ?? null;

  const db = getDb();

  try {
    // Atomic: lookup deleted item's product_id, set swap link on target row, then delete.
    // Wrapped in a transaction so a missing target row rolls back the delete.
    const result = await db.transaction(async (tx) => {
      const targetRows = await tx.execute(sql`
        SELECT product_id FROM shelf_items
        WHERE id = ${id} AND user_id = ${auth.userId}
      `);

      if ((targetRows as unknown[]).length === 0) {
        return { deleted: false, linked: false, notFound: true };
      }

      const deletedProductId = String(
        (targetRows as Record<string, unknown>[])[0].product_id,
      );

      let linked = false;
      if (swapLinkToProductId) {
        // Don't allow self-link (deleting and linking to the same product)
        if (swapLinkToProductId === deletedProductId) {
          return { deleted: false, linked: false, selfLink: true };
        }

        const linkRows = await tx.execute(sql`
          UPDATE shelf_items
          SET swapped_from_id = ${deletedProductId}, updated_at = now()
          WHERE user_id = ${auth.userId} AND product_id = ${swapLinkToProductId}
          RETURNING id
        `);
        linked = (linkRows as unknown[]).length > 0;

        // If the swap target wasn't on the user's shelf, fail the whole op
        // rather than silently dropping the link.
        if (!linked) {
          return { deleted: false, linked: false, missingLink: true };
        }
      }

      await tx.execute(sql`
        DELETE FROM shelf_items
        WHERE id = ${id} AND user_id = ${auth.userId}
      `);

      return { deleted: true, linked };
    });

    if ('notFound' in result && result.notFound) {
      return NextResponse.json({ error: 'not_found' }, { status: 404 });
    }
    if ('selfLink' in result && result.selfLink) {
      return NextResponse.json({ error: 'self_link_invalid' }, { status: 400 });
    }
    if ('missingLink' in result && result.missingLink) {
      return NextResponse.json({ error: 'swap_link_target_not_on_shelf' }, { status: 400 });
    }

    log.info('shelf_delete_ok', {
      user_id: auth.userId,
      shelf_item_id: id,
      linked: result.linked,
    });

    const response: DeleteShelfResponse = {
      deleted: result.deleted,
      linked: result.linked,
    };
    return NextResponse.json(response);
  } catch (err) {
    log.error('shelf_delete_failed', {
      user_id: auth.userId,
      shelf_item_id: id,
      error: String(err),
    });
    return NextResponse.json({ error: 'shelf_delete_failed' }, { status: 500 });
  }
}

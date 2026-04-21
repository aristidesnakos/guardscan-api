/**
 * GET /api/products/:id
 *
 * Look up a product by:
 *   - UUID (DB primary key)
 *   - Synthetic ID (e.g. "off:381372024529") — extracts barcode and looks up by barcode
 *
 * Returns the full Product with ingredients, score, and alternatives.
 */

import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';

import type { Product, ScoreBreakdown } from '@/types/guardscan';
import { requireUser } from '@/lib/auth';
import { getDb, isDatabaseConfigured } from '@/db/client';
import { products, productIngredients } from '@/db/schema';
import { log } from '@/lib/logger';
import { resolveImageUrl } from '@/lib/storage/supabase';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** UUID v4 pattern */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Synthetic ID pattern: "off:123456", "obf:123456", "dsld:123456" */
const SYNTHETIC_RE = /^(off|obf|dsld):(\d+)$/;

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireUser(request);
  if (auth instanceof NextResponse) return auth;

  const { id } = await params;

  if (!isDatabaseConfigured()) {
    return NextResponse.json(
      { error: 'database_not_configured' },
      { status: 503 },
    );
  }

  const db = getDb();

  try {
    let row;

    if (UUID_RE.test(id)) {
      // Direct UUID lookup
      const rows = await db
        .select()
        .from(products)
        .where(eq(products.id, id))
        .limit(1);
      row = rows[0];
    } else {
      // Synthetic ID — extract barcode and look up by barcode
      const match = SYNTHETIC_RE.exec(id);
      if (match) {
        const barcode = match[2];
        const rows = await db
          .select()
          .from(products)
          .where(eq(products.barcode, barcode))
          .limit(1);
        row = rows[0];
      }
    }

    if (!row) {
      return NextResponse.json(
        { error: 'not_found', id },
        { status: 404 },
      );
    }

    // Fetch ingredients
    const ings = await db
      .select()
      .from(productIngredients)
      .where(eq(productIngredients.productId, row.id));

    const product: Product = {
      id: row.id,
      barcode: row.barcode,
      name: row.name,
      brand: row.brand ?? '',
      category: row.category as Product['category'],
      subcategory: row.subcategory ?? null,
      image_url: resolveImageUrl(row.imageFront),
      data_completeness: ings.length > 0 ? 'full' : 'partial',
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

    const score = row.scoreBreakdown as ScoreBreakdown | null;

    log.info('product_by_id', { id, product_id: row.id, barcode: row.barcode });

    return NextResponse.json({ product, score }, {
      headers: {
        'Cache-Control': 'public, max-age=0, s-maxage=3600, stale-while-revalidate=86400',
      },
    });
  } catch (err) {
    log.error('product_by_id_failed', { id, error: String(err) });
    return NextResponse.json(
      { error: 'internal_error' },
      { status: 500 },
    );
  }
}

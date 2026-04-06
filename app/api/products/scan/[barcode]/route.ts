/**
 * GET /api/products/scan/:barcode — M1 route.
 *
 * Lookup order (M1):
 *   1. If DATABASE_URL is set, check the `products` cache by barcode.
 *   2. Otherwise (or on cache miss) fetch from Open Food Facts.
 *   3. Normalize → score → respond.
 *   4. `after()` writes the fresh row back to the cache so subsequent scans
 *      hit the DB path. M1 is DB-optional: if Postgres is unavailable we
 *      silently skip the cache write. M2.5 adds subcategory inference here.
 *
 * Runtime: Node.js (default). Edge is not suitable — we use postgres.js,
 * zod, and rely on Fluid Compute instance reuse for connection pooling.
 * Timeout: inherits 300s default on Fluid Compute (more than enough).
 */

import { NextResponse, after } from 'next/server';
import { eq } from 'drizzle-orm';

import type { LifeStage, ScanResult } from '@/types/guardscan';
import { requireUser } from '@/lib/auth';
import { log, logCacheHit, logCacheMiss } from '@/lib/logger';
import { fetchOffProduct, OffFetchError } from '@/lib/sources/openfoodfacts';
import { normalizeOffProduct } from '@/lib/normalize';
import { scoreProduct } from '@/lib/scoring';
import { getDb, isDatabaseConfigured } from '@/db/client';
import { products } from '@/db/schema';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const VALID_LIFE_STAGES: LifeStage[] = [
  'general_wellness',
  'actively_trying_to_conceive',
  'testosterone_optimization',
  'athletic_performance',
  'longevity_focus',
];

function parseLifeStage(value: string | null): LifeStage | undefined {
  if (!value) return undefined;
  return (VALID_LIFE_STAGES as string[]).includes(value)
    ? (value as LifeStage)
    : undefined;
}

function isValidBarcode(barcode: string): boolean {
  // EAN-8, EAN-13, UPC-A, UPC-E, ITF-14 — allow 6–14 digits.
  return /^\d{6,14}$/.test(barcode);
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ barcode: string }> },
) {
  const startedAt = Date.now();

  const auth = requireUser(request);
  if (auth instanceof NextResponse) return auth;

  const { barcode } = await params;
  log.info('scan_request', {
    barcode,
    user_id: auth.userId,
    auth_source: auth.source,
  });

  if (!isValidBarcode(barcode)) {
    log.warn('scan_invalid_barcode', { barcode });
    return NextResponse.json(
      { error: 'invalid_barcode', barcode },
      { status: 400 },
    );
  }

  const url = new URL(request.url);
  const lifeStage = parseLifeStage(url.searchParams.get('life_stage'));

  // ── 1. DB cache (only when configured) ──────────────────────────────────
  if (isDatabaseConfigured()) {
    try {
      const db = getDb();
      const cached = await db
        .select()
        .from(products)
        .where(eq(products.barcode, barcode))
        .limit(1);

      if (cached.length > 0) {
        logCacheHit(barcode, cached[0].source);
        // M3 will reconstruct the full `Product` (with ingredients) from the
        // `product_ingredients` table. For M1 we intentionally skip to the
        // OFF path on every request since ingredients aren't persisted yet.
      }
    } catch (err) {
      log.warn('db_cache_read_failed', { barcode, error: String(err) });
      // Fall through to OFF — DB is optional in M1.
    }
  }

  // ── 2. Open Food Facts lookup ──────────────────────────────────────────
  let offProduct;
  try {
    offProduct = await fetchOffProduct(barcode);
  } catch (err) {
    if (err instanceof OffFetchError) {
      log.error('off_fetch_failed', {
        barcode,
        message: err.message,
      });
      return NextResponse.json(
        { error: 'upstream_unavailable', barcode },
        { status: 502 },
      );
    }
    throw err;
  }

  if (!offProduct) {
    logCacheMiss(barcode, 'not_in_off');
    return NextResponse.json(
      {
        error: 'not_found',
        barcode,
        capture: true,
      },
      { status: 404 },
    );
  }

  // ── 3. Normalize + score ───────────────────────────────────────────────
  const product = normalizeOffProduct(offProduct, barcode);

  if (product.ingredients.length === 0) {
    logCacheMiss(barcode, 'no_ingredients');
  }

  const score = scoreProduct({
    product,
    lifeStage,
    nutriscoreScore: offProduct.nutriscore_score,
  });

  const result: ScanResult = {
    product,
    score,
    supplement_quality: null, // M2
    alternatives: [], // M2.5
  };

  log.info('scan_ok', {
    barcode,
    duration_ms: Date.now() - startedAt,
    score: score?.overall_score ?? null,
    completeness: product.data_completeness,
    ingredient_count: product.ingredients.length,
  });

  // ── 4. Background cache write (non-blocking) ───────────────────────────
  if (isDatabaseConfigured()) {
    after(async () => {
      try {
        const db = getDb();
        await db
          .insert(products)
          .values({
            barcode: product.barcode,
            name: product.name || '(unknown)',
            brand: product.brand || null,
            category: product.category,
            imageFront: product.image_url,
            source: 'off',
            sourceId: barcode,
            score: score?.overall_score ?? null,
            scoreBreakdown: score ?? null,
          })
          .onConflictDoUpdate({
            target: products.barcode,
            set: {
              name: product.name || '(unknown)',
              brand: product.brand || null,
              imageFront: product.image_url,
              score: score?.overall_score ?? null,
              scoreBreakdown: score ?? null,
              lastSyncedAt: new Date(),
            },
          });
        log.info('product_cache_write', { barcode });
      } catch (err) {
        log.warn('product_cache_write_failed', {
          barcode,
          error: String(err),
        });
      }
    });
  }

  return NextResponse.json(result, {
    headers: {
      'Cache-Control': 'public, max-age=0, s-maxage=3600, stale-while-revalidate=86400',
    },
  });
}

/**
 * GET /api/products/scan/:barcode
 *
 * Multi-source product resolution:
 *   1. DB cache check (any source) — serve if found with ingredients persisted.
 *   2. OFF + OBF lookup in parallel — first non-null wins.
 *      OFF hit → normalize as food, score.
 *      OBF hit → normalize as grooming, score.
 *   3. 404 with { capture: true } — triggers user submission flow in the app.
 *
 * `after()` writes product + ingredients to DB cache so subsequent scans
 * hit step 1 directly. DB is optional — all writes are fire-and-forget.
 */

import { NextResponse, after } from 'next/server';
import { eq, and, ne, gte, isNotNull, desc } from 'drizzle-orm';

import type { LifeStage, Product, ProductAlternative, ScanResult, ScoreBreakdown } from '@/types/guardscan';
import { requireUser } from '@/lib/auth';
import { log, logCacheHit, logCacheMiss } from '@/lib/logger';
import { fetchOffProduct, OffFetchError } from '@/lib/sources/openfoodfacts';
import { fetchObfProduct, ObfFetchError } from '@/lib/sources/openbeautyfacts';
import { normalizeOffProduct, normalizeObfProduct } from '@/lib/normalize';
import { scoreProduct } from '@/lib/scoring';
import { MIN_SCORE_DELTA, getRating } from '@/lib/scoring/constants';
import { inferSubcategory } from '@/lib/subcategory';
import { getDb, isDatabaseConfigured } from '@/db/client';
import { products, productIngredients, scanEvents } from '@/db/schema';

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

/** Fetch top 3 alternatives inline (contract: STRIP_MAX_ALTERNATIVES = 3). */
async function fetchInlineAlternatives(
  db: ReturnType<typeof getDb>,
  productId: string,
  subcategory: string | null,
  productScore: number | null,
): Promise<ProductAlternative[]> {
  if (!subcategory || productScore == null) return [];

  const minScore = productScore + MIN_SCORE_DELTA;
  const altRows = await db
    .select()
    .from(products)
    .where(
      and(
        eq(products.subcategory, subcategory),
        gte(products.score, minScore),
        ne(products.id, productId),
        isNotNull(products.scoreBreakdown),
      ),
    )
    .orderBy(desc(products.score))
    .limit(3);

  const alternatives: ProductAlternative[] = [];
  for (const row of altRows) {
    const delta = (row.score ?? 0) - productScore;
    const { label: rating } = getRating(row.score ?? 0);
    alternatives.push({
      product: {
        id: row.id,
        barcode: row.barcode,
        name: row.name,
        brand: row.brand ?? '',
        category: row.category as Product['category'],
        subcategory: row.subcategory ?? null,
        image_url: row.imageFront ?? null,
        data_completeness: 'full',
        ingredient_source: row.source === 'dsld' ? 'verified' : 'open_food_facts',
        ingredients: [], // Omit ingredients in strip view for payload size
        created_at: row.createdAt.toISOString(),
        updated_at: row.lastSyncedAt.toISOString(),
      },
      score: row.score ?? 0,
      rating,
      reason: `Scores ${delta} points higher`,
    });
  }
  return alternatives;
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

  // ── 1. DB cache check ───────────────────────────────────────────────────
  if (isDatabaseConfigured()) {
    try {
      const db = getDb();
      const cached = await db
        .select()
        .from(products)
        .where(eq(products.barcode, barcode))
        .limit(1);

      if (cached.length > 0) {
        const row = cached[0];
        logCacheHit(barcode, row.source);

        // Serve from cache if we have score + persisted ingredients
        if (row.scoreBreakdown) {
          const cachedIngredients = await db
            .select()
            .from(productIngredients)
            .where(eq(productIngredients.productId, row.id));

          if (cachedIngredients.length > 0) {
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
              ingredients: cachedIngredients.map((ing) => ({
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

            // Re-score with personalization if life_stage provided
            const score = lifeStage
              ? scoreProduct({ product, lifeStage })
              : row.scoreBreakdown as ScoreBreakdown;

            // Inline alternatives (top 3 in same subcategory)
            const alternatives = await fetchInlineAlternatives(
              db, row.id, row.subcategory, row.score,
            );

            const result: ScanResult = {
              product,
              score,
              supplement_quality: null,
              alternatives,
            };

            // Record scan event in background
            if (auth.userId) {
              after(async () => {
                try {
                  await db.insert(scanEvents).values({
                    userId: auth.userId!,
                    productId: row.id,
                  });
                } catch (err) {
                  log.warn('scan_event_write_failed', { barcode, error: String(err) });
                }
              });
            }

            log.info('scan_ok_cached', {
              barcode,
              duration_ms: Date.now() - startedAt,
              score: score?.overall_score ?? null,
              source: row.source,
              alternatives_count: alternatives.length,
            });

            return NextResponse.json(result, {
              headers: {
                'Cache-Control': 'public, max-age=0, s-maxage=3600, stale-while-revalidate=86400',
              },
            });
          }
        }
        // Cache hit but no ingredients persisted — fall through to live lookup
      }
    } catch (err) {
      log.warn('db_cache_read_failed', { barcode, error: String(err) });
    }
  }

  // ── 2. OFF + OBF in parallel ────────────────────────────────────────────
  let product: Product | null = null;
  let nutriscoreScore: number | undefined;
  let source: 'off' | 'obf' = 'off';

  const [offResult, obfResult] = await Promise.allSettled([
    fetchOffProduct(barcode),
    fetchObfProduct(barcode),
  ]);

  const offData = offResult.status === 'fulfilled' ? offResult.value : null;
  const obfData = obfResult.status === 'fulfilled' ? obfResult.value : null;

  if (offData) {
    product = normalizeOffProduct(offData, barcode);
    nutriscoreScore = offData.nutriscore_score;
    source = 'off';

    // If OFF detects a grooming product and OBF has authoritative data, prefer OBF
    if (product.category === 'grooming' && obfData) {
      product = normalizeObfProduct(obfData, barcode);
      nutriscoreScore = undefined;
      source = 'obf';
      log.info('source_preference_override', {
        barcode,
        reason: 'off_detected_grooming_prefer_obf',
      });
    }
  } else if (obfData) {
    product = normalizeObfProduct(obfData, barcode);
    source = 'obf';
  }

  // Nutri-Score is meaningless for non-food products
  if (product && product.category !== 'food') {
    nutriscoreScore = undefined;
  }

  // Log upstream errors (non-404 failures)
  if (offResult.status === 'rejected') {
    if (offResult.reason instanceof OffFetchError) {
      log.warn('off_fetch_failed', { barcode, message: offResult.reason.message });
    }
  }
  if (obfResult.status === 'rejected') {
    if (obfResult.reason instanceof ObfFetchError) {
      log.warn('obf_fetch_failed', { barcode, message: obfResult.reason.message });
    }
  }

  // Both upstream sources failed with errors (not just 404s)
  if (
    !product &&
    offResult.status === 'rejected' &&
    obfResult.status === 'rejected'
  ) {
    log.error('all_sources_failed', { barcode });
    return NextResponse.json(
      { error: 'upstream_unavailable', barcode },
      { status: 502 },
    );
  }

  if (!product) {
    logCacheMiss(barcode, 'not_in_off');
    return NextResponse.json(
      { error: 'not_found', barcode, capture: true },
      { status: 404 },
    );
  }

  // ── 3. Score ────────────────────────────────────────────────────────────
  if (product.ingredients.length === 0) {
    logCacheMiss(barcode, 'no_ingredients');
  }

  // Infer subcategory before scoring — pass raw category tags for better matching
  const rawCategoryTags = source === 'off' ? offData?.categories_tags
    : source === 'obf' ? obfData?.categories_tags
    : undefined;
  product.subcategory = inferSubcategory(product.name, product.category, rawCategoryTags);

  const score = scoreProduct({
    product,
    lifeStage,
    nutriscoreScore,
  });

  // Inline alternatives (top 3) — only if DB is available
  let alternatives: ProductAlternative[] = [];
  if (isDatabaseConfigured() && product.subcategory && score) {
    try {
      const db = getDb();
      // Need the product's DB ID — it may already exist from a prior scan
      const [existing] = await db
        .select({ id: products.id })
        .from(products)
        .where(eq(products.barcode, barcode))
        .limit(1);

      if (existing) {
        alternatives = await fetchInlineAlternatives(
          db, existing.id, product.subcategory, score.overall_score,
        );
      }
    } catch (err) {
      log.warn('inline_alternatives_failed', { barcode, error: String(err) });
    }
  }

  const result: ScanResult = {
    product,
    score,
    supplement_quality: null,
    alternatives,
  };

  log.info('scan_ok', {
    barcode,
    duration_ms: Date.now() - startedAt,
    score: score?.overall_score ?? null,
    completeness: product.data_completeness,
    ingredient_count: product.ingredients.length,
    source,
    alternatives_count: alternatives.length,
  });

  // ── 4. Background cache write (non-blocking) ───────────────────────────
  if (isDatabaseConfigured()) {
    after(async () => {
      try {
        const db = getDb();

        // Upsert product row
        const [row] = await db
          .insert(products)
          .values({
            barcode: product.barcode,
            name: product.name || '(unknown)',
            brand: product.brand || null,
            category: product.category,
            subcategory: product.subcategory,
            imageFront: product.image_url,
            rawIngredients: product.ingredients.map((i) => i.name).join(', '),
            source,
            sourceId: barcode,
            score: score?.overall_score ?? null,
            scoreBreakdown: score ?? null,
          })
          .onConflictDoUpdate({
            target: products.barcode,
            set: {
              name: product.name || '(unknown)',
              brand: product.brand || null,
              category: product.category,
              subcategory: product.subcategory,
              imageFront: product.image_url,
              rawIngredients: product.ingredients.map((i) => i.name).join(', '),
              source,
              score: score?.overall_score ?? null,
              scoreBreakdown: score ?? null,
              lastSyncedAt: new Date(),
            },
          })
          .returning({ id: products.id });

        // Persist ingredients for cache reconstruction
        if (row && product.ingredients.length > 0) {
          await db
            .delete(productIngredients)
            .where(eq(productIngredients.productId, row.id));

          await db.insert(productIngredients).values(
            product.ingredients.map((ing) => ({
              productId: row.id,
              position: ing.position,
              name: ing.name,
              normalized: ing.name.toLowerCase().trim(),
              flag: ing.flag,
              reason: ing.reason || null,
            })),
          );
        }

        // Record scan event for recommendations
        if (row && auth.userId) {
          await db.insert(scanEvents).values({
            userId: auth.userId,
            productId: row.id,
          });
        }

        log.info('product_cache_write', { barcode, source });
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

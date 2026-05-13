/**
 * Shared ingest utilities for cron jobs.
 *
 * Provides batch product upsert (product + ingredients atomically in a
 * single DB transaction), gzip JSONL fetch, and cron state tracking.
 *
 * Translation claim (2026-05-13): when an incoming product.name looks
 * foreign, upsertProduct synchronously calls the translator and stores both
 * the English translation (in `name`) and the source-language original (in
 * `original_name`). Subsequent ingest sights of the same barcode preserve
 * the translation — see resolveClaim below.
 */

import { eq } from 'drizzle-orm';
import { gunzipSync } from 'node:zlib';

import type { Product, ScoreBreakdown } from '@/types/guardscan';
import type { Database } from '@/db/client';
import { products, productIngredients, cronState } from '@/db/schema';
import { log } from '@/lib/logger';
import { inferSubcategoryHybrid } from '@/lib/llm/classifier';
import { normalizeIngredientName } from '@/lib/dictionary/resolve';
import { isHardware } from '@/lib/hardware-filter';
import {
  isTranslatorEnabled,
  looksForeign,
  translateProductName,
} from '@/lib/translation';

// ── Translation claim ───────────────────────────────────────────────────────
//
// Resolves what to write for the name/original_name/source_language/
// translation_status quartet given an incoming `product` and the existing DB
// row (if any). Pure-ish — the only side effect is one LLM call when an
// untracked foreign name arrives.
//
// Decision tree:
//   existing.translation_status = 'manual'   → never touch any field. Sacred.
//   existing.original_name IS NOT NULL       → keep our `name`, refresh
//                                              original_name with incoming
//                                              (visibility for auditing).
//                                              status/lang unchanged.
//   no existing row OR no claim              → check looksForeign(incoming).
//                                              If foreign, call translator
//                                              synchronously. Success →
//                                              status='auto'. Failure →
//                                              status='failed' (retry on
//                                              next sight). is_english from
//                                              LLM → no claim written.

type TranslationResolution = {
  name: string;
  originalName: string | null;
  sourceLanguage: string | null;
  translationStatus: 'auto' | 'manual' | 'pending' | 'failed' | 'disputed' | null;
  // Was the existing row's claim preserved? Affects whether we should refresh
  // upstream fields (image, raw_ingredients, etc.) — we always refresh those,
  // but this flag is useful for logging.
  preservedExistingName: boolean;
};

type ExistingProductClaim = {
  name: string;
  originalName: string | null;
  sourceLanguage: string | null;
  translationStatus: 'auto' | 'manual' | 'pending' | 'failed' | 'disputed' | null;
};

export async function resolveClaim(
  product: Product,
  existing: ExistingProductClaim | null,
): Promise<TranslationResolution> {
  const incomingName = product.name?.trim() || '(unknown)';

  // 1. Manual claim is sacred — neither cron nor translator touches it.
  if (existing?.translationStatus === 'manual') {
    return {
      name: existing.name,
      originalName: existing.originalName,
      sourceLanguage: existing.sourceLanguage,
      translationStatus: 'manual',
      preservedExistingName: true,
    };
  }

  // 2. Auto-translated (or pending/failed/disputed) — preserve our English
  // name. Refresh original_name with incoming so admins can see when upstream
  // changes the source value. Status + language remain whatever they were.
  if (existing && existing.originalName) {
    return {
      name: existing.name,
      originalName: incomingName,
      sourceLanguage: existing.sourceLanguage,
      translationStatus: existing.translationStatus,
      preservedExistingName: true,
    };
  }

  // 3. No claim yet — check incoming for foreign signal.
  if (!looksForeign(incomingName)) {
    return {
      name: incomingName,
      originalName: null,
      sourceLanguage: null,
      translationStatus: null,
      preservedExistingName: false,
    };
  }

  // 4. Foreign-looking. Skip the LLM call if it's not configured — write the
  // name through and mark pending so the outbox/backfill picks it up later.
  if (!isTranslatorEnabled()) {
    return {
      name: incomingName,
      originalName: incomingName,
      sourceLanguage: null,
      translationStatus: 'pending',
      preservedExistingName: false,
    };
  }

  // 5. Translate synchronously. On any failure, write original + 'failed' so
  // the row retries on next ingest sight.
  const result = await translateProductName({
    name: incomingName,
    brand: product.brand || null,
    category: product.category,
  });

  if (!result) {
    return {
      name: incomingName,
      originalName: incomingName,
      sourceLanguage: null,
      translationStatus: 'failed',
      preservedExistingName: false,
    };
  }

  // LLM said "actually English" — believe it, no claim.
  if (result.is_english) {
    return {
      name: incomingName,
      originalName: null,
      sourceLanguage: null,
      translationStatus: null,
      preservedExistingName: false,
    };
  }

  // Translation succeeded.
  return {
    name: result.translated || incomingName,
    originalName: incomingName,
    sourceLanguage: result.language || null,
    translationStatus: 'auto',
    preservedExistingName: false,
  };
}

// ── Product upsert ──────────────────────────────────────────────────────────

export async function upsertProduct(
  db: Database,
  product: Product,
  source: 'off' | 'obf' | 'dsld' | 'user',
  score: ScoreBreakdown | null,
  subcategory: string | null,
  sourceId?: string,
): Promise<string | null> {
  try {
    // Hardware exclusion: physical accessories (razors, combs, brushes,
    // trimmers, …) have no ingredients to score and pollute alternatives.
    // Drop them before we touch the DB.
    if (isHardware(product.name || '')) {
      log.info('upsert_skip_hardware', {
        barcode: product.barcode,
        name: product.name,
      });
      return null;
    }

    // LLM fallback: if the caller couldn't determine a subcategory via
    // keyword matching, try the hybrid classifier before we write. No-op
    // when OPENROUTER_API_KEY is unset (returns the original null).
    const resolvedSubcategory =
      subcategory ??
      (await inferSubcategoryHybrid(
        product.name || '',
        product.category,
      ));

    return await db.transaction(async (tx) => {
      // Read existing row to apply translation claim (see resolveClaim).
      const [existing] = await tx
        .select({
          id: products.id,
          name: products.name,
          originalName: products.originalName,
          sourceLanguage: products.sourceLanguage,
          translationStatus: products.translationStatus,
        })
        .from(products)
        .where(eq(products.barcode, product.barcode))
        .limit(1);

      const claim = await resolveClaim(product, existing ?? null);

      if (claim.preservedExistingName && existing) {
        log.info('upsert_claim_preserved', {
          barcode: product.barcode,
          status: claim.translationStatus,
          incoming_name: product.name,
          preserved_name: claim.name,
        });
      }

      const upsertValues = {
        barcode: product.barcode,
        name: claim.name,
        originalName: claim.originalName,
        sourceLanguage: claim.sourceLanguage,
        translationStatus: claim.translationStatus,
        brand: product.brand || null,
        category: product.category,
        subcategory: resolvedSubcategory,
        imageFront: product.image_url,
        rawIngredients: product.ingredients.map((i) => i.name).join(', '),
        source,
        sourceId: sourceId ?? product.id,
        score: score?.overall_score ?? null,
        scoreBreakdown: score ?? null,
        outcomeFlags: score?.outcome_flags ?? null,
      };

      const [row] = await tx
        .insert(products)
        .values(upsertValues)
        .onConflictDoUpdate({
          target: products.barcode,
          set: {
            // Claim fields — already resolved, safe to write as-is. For a
            // 'manual' row resolveClaim returns the existing values, so
            // these writes are no-ops.
            name: claim.name,
            originalName: claim.originalName,
            sourceLanguage: claim.sourceLanguage,
            translationStatus: claim.translationStatus,
            // Upstream fields — always refresh from incoming so we don't
            // stale-out images, ingredients, scores, etc.
            brand: product.brand || null,
            category: product.category,
            subcategory: resolvedSubcategory,
            imageFront: product.image_url,
            rawIngredients: product.ingredients.map((i) => i.name).join(', '),
            source,
            score: score?.overall_score ?? null,
            scoreBreakdown: score ?? null,
            outcomeFlags: score?.outcome_flags ?? null,
            lastSyncedAt: new Date(),
          },
        })
        .returning({ id: products.id });

      if (!row) return null;

      // Replace ingredients atomically — if this insert fails, the product
      // row above is also rolled back so no orphan can form.
      if (product.ingredients.length > 0) {
        await tx
          .delete(productIngredients)
          .where(eq(productIngredients.productId, row.id));

        await tx.insert(productIngredients).values(
          product.ingredients.map((ing) => ({
            productId: row.id,
            position: ing.position,
            name: ing.name,
            normalized: normalizeIngredientName(ing.name),
            flag: ing.flag,
            reason: ing.reason || null,
          })),
        );
      }

      return row.id;
    });
  } catch (err) {
    log.warn('upsert_product_failed', {
      barcode: product.barcode,
      error: String(err),
    });
    return null;
  }
}

// ── Batch upsert ────────────────────────────────────────────────────────────

export type IngestItem = {
  product: Product;
  source: 'off' | 'obf' | 'dsld' | 'user';
  score: ScoreBreakdown | null;
  subcategory: string | null;
  sourceId?: string;
};

export async function batchUpsert(
  db: Database,
  items: IngestItem[],
): Promise<{ upserted: number; errors: number }> {
  let upserted = 0;
  let errors = 0;

  for (const item of items) {
    const id = await upsertProduct(
      db,
      item.product,
      item.source,
      item.score,
      item.subcategory,
      item.sourceId,
    );
    if (id) upserted++;
    else errors++;
  }

  return { upserted, errors };
}

// ── Gzip JSONL fetch ────────────────────────────────────────────────────────

export async function fetchGzipJsonl<T = unknown>(url: string): Promise<T[]> {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(60_000), // delta files can be a few MB
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: HTTP ${response.status}`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  const decompressed = gunzipSync(buffer).toString('utf-8');

  return decompressed
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as T);
}

// ── Cron state tracking ─────────────────────────────────────────────────────

export async function getCronState(
  db: Database,
  jobName: string,
): Promise<{ lastProcessedKey: string | null; metadata: unknown }> {
  const rows = await db
    .select()
    .from(cronState)
    .where(eq(cronState.jobName, jobName))
    .limit(1);

  if (rows.length === 0) {
    return { lastProcessedKey: null, metadata: null };
  }
  return {
    lastProcessedKey: rows[0].lastProcessedKey,
    metadata: rows[0].metadata,
  };
}

export async function setCronState(
  db: Database,
  jobName: string,
  key: string | null,
  status: 'success' | 'partial' | 'failed',
  metadata?: Record<string, unknown>,
): Promise<void> {
  await db
    .insert(cronState)
    .values({
      jobName,
      lastProcessedKey: key,
      lastRunAt: new Date(),
      lastRunStatus: status,
      metadata: metadata ?? null,
    })
    .onConflictDoUpdate({
      target: cronState.jobName,
      set: {
        lastProcessedKey: key,
        lastRunAt: new Date(),
        lastRunStatus: status,
        metadata: metadata ?? null,
      },
    });
}

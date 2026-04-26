/**
 * Shared ingest utilities for cron jobs.
 *
 * Provides batch product upsert (product + ingredients atomically in a
 * single DB transaction), gzip JSONL fetch, and cron state tracking.
 */

import { eq } from 'drizzle-orm';
import { gunzipSync } from 'node:zlib';

import type { Product, ScoreBreakdown } from '@/types/guardscan';
import type { Database } from '@/db/client';
import { products, productIngredients, cronState } from '@/db/schema';
import { log } from '@/lib/logger';
import { inferSubcategoryHybrid } from '@/lib/llm/classifier';
import { normalizeIngredientName } from '@/lib/dictionary/resolve';

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
      const [row] = await tx
        .insert(products)
        .values({
          barcode: product.barcode,
          name: product.name || '(unknown)',
          brand: product.brand || null,
          category: product.category,
          subcategory: resolvedSubcategory,
          imageFront: product.image_url,
          rawIngredients: product.ingredients.map((i) => i.name).join(', '),
          source,
          sourceId: sourceId ?? product.id,
          score: score?.overall_score ?? null,
          scoreBreakdown: score ?? null,
        })
        .onConflictDoUpdate({
          target: products.barcode,
          set: {
            name: product.name || '(unknown)',
            brand: product.brand || null,
            category: product.category,
            subcategory: resolvedSubcategory,
            imageFront: product.image_url,
            rawIngredients: product.ingredients.map((i) => i.name).join(', '),
            source,
            score: score?.overall_score ?? null,
            scoreBreakdown: score ?? null,
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

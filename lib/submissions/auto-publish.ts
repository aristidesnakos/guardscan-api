/**
 * Shared publish path for user submissions.
 *
 * Two entry points share the same canonical-product build + upsert logic:
 *
 *   - tryAutoPublish: called from POST /api/products/submit right after
 *     Claude Vision extracts the front/back labels. Enforces confidence
 *     and data-quality guardrails. On skip/failure the submission is left
 *     as 'pending' so scripts/admin-submissions.ts can still clear it.
 *
 *   - publishExtracted: called from the CLI admin tool after an operator
 *     has manually verified the extracted fields. No gating — the operator
 *     already decided this was good data. `reviewedBy` is set to a
 *     non-null value to distinguish manual publishes from auto-publishes
 *     in the audit trail (reviewed_by IS NULL ⇒ auto-published).
 *
 * Both entry points reuse `upsertProduct` from lib/cron/ingest-helpers.ts
 * so user-submitted products go through the exact same catalog insert
 * path as OFF/OBF/DSLD ingest.
 */

import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';

import type { Ingredient, Product, ProductCategory } from '@/types/guardscan';
import { getDb } from '@/db/client';
import { userSubmissions } from '@/db/schema';
import { lookupIngredient } from '@/lib/dictionary/lookup';
import { scoreProduct } from '@/lib/scoring';
import { inferSubcategory } from '@/lib/subcategory';
import { upsertProduct } from '@/lib/cron/ingest-helpers';
import { log } from '@/lib/logger';
import type { ExtractedSubmission } from '@/lib/ocr/claude-vision';

/** Minimum Claude confidence (0–100) required for auto-publish. */
export const AUTO_PUBLISH_CONFIDENCE_THRESHOLD = 90;

/** Discriminated result from {@link tryAutoPublish}. */
export type AutoPublishResult =
  | { kind: 'published'; productId: string; score: number | null }
  | {
      kind: 'skipped';
      reason:
        | 'disabled'
        | 'low_confidence'
        | 'guardrail_name'
        | 'guardrail_category'
        | 'guardrail_ingredients';
    }
  | { kind: 'failed'; error: string };

/**
 * Build the canonical `Ingredient[]` from raw ingredient strings by
 * looking each one up in the in-memory dictionary. Unknown ingredients
 * resolve to `{ flag: 'neutral', reason: '' }` per the charter's
 * "unknown = neutral" requirement.
 */
function resolveIngredients(rawIngredients: string[]): Ingredient[] {
  return rawIngredients.map((name, i) => {
    const normalized = name.toLowerCase().trim();
    const entry = lookupIngredient(normalized);
    return {
      name,
      position: i + 1,
      flag: entry?.flag ?? 'neutral',
      reason: entry?.reason ?? '',
      fertility_relevant: entry?.fertility_relevant ?? false,
      testosterone_relevant: entry?.testosterone_relevant ?? false,
    };
  });
}

/**
 * Build the canonical Product, infer its subcategory, score it, and
 * upsert it into the products table with `source='user'`. Shared by
 * both the auto-publish path and the CLI operator path.
 *
 * Returns the inserted product ID and the score, or null + an error
 * string on failure (DB error, upsert returned null, etc).
 */
async function buildAndPublish(args: {
  submissionId: string;
  barcode: string;
  name: string;
  brand: string | null;
  category: ProductCategory;
  rawIngredients: string[];
  reviewedBy: string | null;
}): Promise<
  | { ok: true; productId: string; score: number | null }
  | { ok: false; error: string }
> {
  const db = getDb();
  const now = new Date().toISOString();

  const ingredients = resolveIngredients(args.rawIngredients);

  const product: Product = {
    id: randomUUID(),
    barcode: args.barcode,
    name: args.name,
    brand: args.brand ?? '',
    category: args.category,
    subcategory: null,
    image_url: null,
    data_completeness: 'full',
    ingredient_source: 'user_contributed',
    ingredients,
    created_at: now,
    updated_at: now,
  };

  // Subcategory inference: name-only since Claude doesn't give us raw
  // OFF/OBF category tags. upsertProduct has an LLM fallback if we pass
  // null, but we try keyword matching first for determinism.
  const subcategory = inferSubcategory(product.name, product.category);

  const score = scoreProduct({ product });

  try {
    const productId = await upsertProduct(
      db,
      product,
      'user',
      score,
      subcategory,
      args.submissionId,
    );
    if (!productId) {
      return { ok: false, error: 'upsert_returned_null' };
    }

    await db
      .update(userSubmissions)
      .set({
        status: 'published',
        reviewedBy: args.reviewedBy,
      })
      .where(eq(userSubmissions.id, args.submissionId));

    return {
      ok: true,
      productId,
      score: score?.overall_score ?? null,
    };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

/**
 * Attempt to auto-publish a submission using Claude's extraction output.
 *
 * Gates:
 *   1. Hard guardrails — skip if name is missing, category is missing,
 *      or fewer than 2 ingredients were extracted.
 *   2. Confidence gate — skip if Claude reported confidence below
 *      {@link AUTO_PUBLISH_CONFIDENCE_THRESHOLD}.
 *
 * Skipped submissions are left as `status='pending'` so the CLI admin
 * tool can still review them manually. This function never throws — all
 * errors are returned as `{ kind: 'failed' }`.
 */
export async function tryAutoPublish(args: {
  submissionId: string;
  barcode: string;
  extracted: ExtractedSubmission;
}): Promise<AutoPublishResult> {
  const { submissionId, barcode, extracted } = args;

  // ── Kill switch ──────────────────────────────────────────────────────
  if (process.env.AUTO_PUBLISH_ENABLED === 'false') {
    return { kind: 'skipped', reason: 'disabled' };
  }

  // ── Hard guardrails ──────────────────────────────────────────────────
  if (!extracted.name) {
    return { kind: 'skipped', reason: 'guardrail_name' };
  }
  if (!extracted.category) {
    return { kind: 'skipped', reason: 'guardrail_category' };
  }
  if (extracted.ingredients.length < 2) {
    return { kind: 'skipped', reason: 'guardrail_ingredients' };
  }

  // ── Confidence gate ──────────────────────────────────────────────────
  if (extracted.confidence < AUTO_PUBLISH_CONFIDENCE_THRESHOLD) {
    return { kind: 'skipped', reason: 'low_confidence' };
  }

  // ── Publish ──────────────────────────────────────────────────────────
  const result = await buildAndPublish({
    submissionId,
    barcode,
    name: extracted.name,
    brand: extracted.brand,
    category: extracted.category,
    rawIngredients: extracted.ingredients,
    reviewedBy: null, // null ⇒ auto-published
  });

  if (!result.ok) {
    log.warn('auto_publish_failed', {
      submission_id: submissionId,
      barcode,
      error: result.error,
    });
    return { kind: 'failed', error: result.error };
  }

  return {
    kind: 'published',
    productId: result.productId,
    score: result.score,
  };
}

/**
 * Publish a submission with operator-supplied fields from the CLI
 * admin tool. No guardrails or confidence gate — the operator has
 * already vetted the data. `reviewedBy` must be set to a non-null
 * identifier (admin user ID or `'cli'`).
 *
 * Returns the product ID and score on success, or throws on failure.
 * The CLI prints errors and resets the submission to `pending` itself.
 */
export async function publishExtracted(args: {
  submissionId: string;
  barcode: string;
  name: string;
  brand: string | null;
  category: ProductCategory;
  ingredients: string[];
  reviewedBy: string;
}): Promise<{ productId: string; score: number | null }> {
  const result = await buildAndPublish({
    submissionId: args.submissionId,
    barcode: args.barcode,
    name: args.name,
    brand: args.brand,
    category: args.category,
    rawIngredients: args.ingredients,
    reviewedBy: args.reviewedBy,
  });

  if (!result.ok) {
    throw new Error(result.error);
  }

  return { productId: result.productId, score: result.score };
}

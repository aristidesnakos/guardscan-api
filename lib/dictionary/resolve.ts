/**
 * Single shared ingredient resolution path.
 *
 * Every call site — OFF, OBF, DSLD, user submissions — resolves ingredients
 * through this one function. It normalizes the raw name, looks it up in the
 * dictionary, logs a structured miss event for unknowns, and returns a fully
 * populated Ingredient with the `assessed` flag set.
 *
 * `normalizeIngredientName` is co-located here (not in normalize.ts) to keep
 * the normalization and lookup logic in one place and avoid circular imports.
 */

import type { AssessmentCoverage, Ingredient, ProductCategory, ScoreBreakdown } from '@/types/guardscan';
import { lookupIngredient } from './lookup';
import { log } from '@/lib/logger';

// Minimal shape of a product_ingredients DB row needed by the hydration helper.
type IngredientRow = {
  name: string;
  position: number;
  normalized: string;
  flag: string | null;
  reason: string | null;
};

/**
 * Hydrate a cached `product_ingredients` row back into a full `Ingredient`.
 *
 * Restores `assessed`, `fertility_relevant`, and `testosterone_relevant` from
 * the live in-memory dictionary so that personalized scoring works correctly
 * on cache reads. The DB row's `flag` and `reason` are preferred (they reflect
 * the dictionary at write time); the live entry is the fallback.
 *
 * O(1) — hits the pre-built Map, no I/O.
 */
export function hydrateIngredient(
  row: IngredientRow,
  productCategory?: ProductCategory,
): Ingredient {
  const entry = lookupIngredient(row.normalized, productCategory);
  return {
    name: row.name,
    position: row.position,
    flag: (row.flag ?? entry?.flag ?? 'neutral') as Ingredient['flag'],
    reason: row.reason ?? entry?.reason ?? '',
    fertility_relevant: entry?.fertility_relevant ?? false,
    testosterone_relevant: entry?.testosterone_relevant ?? false,
    health_risk_tags: entry?.health_risk_tags ?? [],
    assessed: entry !== null,
  };
}

/**
 * Synthesize `assessment_coverage` for a cached `ScoreBreakdown` blob that
 * pre-dates the `b06ff6d` commit which introduced the field.
 *
 * If the blob already has the field this is a no-op (returns the same object).
 */
export function withAssessmentCoverage(
  score: ScoreBreakdown,
  ingredients: Ingredient[],
): ScoreBreakdown {
  if (score.assessment_coverage) return score;
  const total = ingredients.length;
  const assessed = ingredients.filter((i) => i.assessed).length;
  const coverage: AssessmentCoverage = {
    total,
    assessed,
    percentage: total === 0 ? 0 : Math.round((assessed / total) * 100),
  };
  return { ...score, assessment_coverage: coverage };
}

export type IngredientResolveSource = 'off' | 'obf' | 'dsld' | 'submission';

/**
 * Normalize a raw ingredient name to a canonical form for dictionary lookup.
 * Strips OFF/OBF structural noise: underscores, organic markers, percentages,
 * parenthetical sub-details, and collapses whitespace.
 */
export function normalizeIngredientName(name: string): string {
  return name
    .toLowerCase()
    .replace(/^\s*_+|_+\s*$/g, '') // OFF/OBF prefix structured names with underscores
    .replace(/[*†‡]+/g, '')        // organic markers, footnote symbols
    .replace(/\s*\d+(\.\d+)?%/g, '') // percentage amounts ("sugar 35%")
    .replace(/\(.*?\)/g, '')        // parenthetical sub-details
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Resolve a single raw ingredient name to a fully-populated `Ingredient`.
 *
 * - If `lookupHint` is provided (derived from OFF/OBF `id` field), tries that
 *   key first, then falls back to text normalization. This gives multilingual
 *   products a path to the English dictionary without breaking existing callers.
 * - On a miss, emits an `ingredient_unassessed` log line and sets `assessed: false`.
 * - Always returns `flag: 'neutral'` for unknowns (charter §13.2).
 */
export function resolveIngredient(
  rawName: string,
  position: number,
  source: IngredientResolveSource,
  lookupHint?: string,
  productCategory?: ProductCategory,
): Ingredient {
  // Try the id-derived key first; if it misses, try text normalization.
  // This preserves full backwards compatibility for DSLD and submissions
  // (they never pass lookupHint) and adds a fallback for the id path.
  const primaryKey = lookupHint
    ? lookupHint.toLowerCase().trim()
    : normalizeIngredientName(rawName);

  let entry = lookupIngredient(primaryKey, productCategory);

  if (!entry && lookupHint) {
    // id-derived key missed — try text normalization as fallback
    entry = lookupIngredient(normalizeIngredientName(rawName), productCategory);
  }

  if (!entry) {
    log.info('ingredient_unassessed', {
      raw: rawName,
      normalized: primaryKey,
      source,
    });
  }

  return {
    name: rawName,
    position,
    flag: entry?.flag ?? 'neutral',
    reason: entry?.reason ?? '',
    fertility_relevant: entry?.fertility_relevant ?? false,
    testosterone_relevant: entry?.testosterone_relevant ?? false,
    health_risk_tags: entry?.health_risk_tags ?? [],
    assessed: entry !== null,
  };
}

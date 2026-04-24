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

import type { Ingredient } from '@/types/guardscan';
import { lookupIngredient } from './lookup';
import { log } from '@/lib/logger';

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
): Ingredient {
  // Try the id-derived key first; if it misses, try text normalization.
  // This preserves full backwards compatibility for DSLD and submissions
  // (they never pass lookupHint) and adds a fallback for the id path.
  const primaryKey = lookupHint
    ? lookupHint.toLowerCase().trim()
    : normalizeIngredientName(rawName);

  let entry = lookupIngredient(primaryKey);

  if (!entry && lookupHint) {
    // id-derived key missed — try text normalization as fallback
    entry = lookupIngredient(normalizeIngredientName(rawName));
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
    assessed: entry !== null,
  };
}

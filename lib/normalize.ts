/**
 * Normalization layer.
 *
 * Turns source-specific payloads (Open Food Facts today, OBF/DSLD in M2) into
 * the canonical `Product` shape the client consumes. This is where we apply
 * the ingredient dictionary to flag each ingredient.
 *
 * M1.5: Uses inline seed dictionary (~60 entries). Unknown ingredients default
 * to `neutral` per charter §13.2. M3 will swap to a DB-backed lookup.
 */

import type {
  DataCompleteness,
  Ingredient,
  IngredientFlag,
  Product,
  ProductCategory,
} from '@/types/guardscan';
import type { OffProduct } from './sources/openfoodfacts';

// ── Category inference ──────────────────────────────────────────────────────

/**
 * OFF only contains food/beverage products, so for M1 the category is always
 * `'food'`. OBF will return grooming in M2; DSLD will return supplement.
 */
export function inferOffCategory(_off: OffProduct): ProductCategory {
  return 'food';
}

// ── Ingredient parsing ──────────────────────────────────────────────────────

/**
 * OFF offers two representations:
 *   1. `ingredients: Ingredient[]` — structured, preferred when present
 *   2. `ingredients_text` — comma/parenthesis-separated free text, fallback
 *
 * We try structured first. If it's missing or empty we split the text on
 * commas and parentheses, which covers the vast majority of labels cleanly.
 */
function parseIngredients(off: OffProduct): { name: string; position: number }[] {
  if (off.ingredients && off.ingredients.length > 0) {
    return off.ingredients
      .map((ing, idx) => ({
        name: (ing.text ?? ing.id ?? '').trim(),
        position: (ing.rank && ing.rank > 0 ? ing.rank : idx + 1),
      }))
      .filter((ing) => ing.name.length > 0);
  }

  const text = off.ingredients_text_en ?? off.ingredients_text ?? '';
  if (!text) return [];

  // Strip parentheticals (sub-ingredients) and split on commas/semicolons.
  return text
    .replace(/\([^)]*\)/g, '')
    .split(/[,;]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((name, idx) => ({ name, position: idx + 1 }));
}

// ── Dictionary lookup ────────────────────────────────────────────────────────

import { lookupIngredient } from './dictionary/lookup';

/**
 * Looks up an ingredient in the inline seed dictionary. Returns neutral for
 * unknown ingredients (charter §13.2). M3 will replace with a DB query.
 */
function lookupIngredientFlag(normalized: string): {
  flag: IngredientFlag;
  reason: string;
  fertilityRelevant: boolean;
  testosteroneRelevant: boolean;
} {
  const entry = lookupIngredient(normalized);
  if (!entry) {
    return { flag: 'neutral', reason: '', fertilityRelevant: false, testosteroneRelevant: false };
  }
  return {
    flag: entry.flag,
    reason: entry.reason,
    fertilityRelevant: entry.fertility_relevant,
    testosteroneRelevant: entry.testosterone_relevant,
  };
}

function normalizeIngredientName(name: string): string {
  return name
    .toLowerCase()
    .replace(/^\s*_+|_+\s*$/g, '') // OFF prefixes structured names with underscores
    .replace(/[*†‡]+/g, '')        // organic markers, footnote symbols
    .replace(/\s*\d+(\.\d+)?%/g, '') // percentage amounts ("sugar 35%")
    .replace(/\(.*?\)/g, '')        // parenthetical sub-details
    .replace(/\s+/g, ' ')
    .trim();
}

// ── Data completeness heuristic ─────────────────────────────────────────────

function determineCompleteness(
  name: string,
  ingredients: Ingredient[],
): DataCompleteness {
  if (!name) return 'barcode_only';
  if (ingredients.length === 0) return 'partial';
  return 'full';
}

// ── Main entry point ────────────────────────────────────────────────────────

/**
 * Turns an OFF product payload into the canonical `Product` shape.
 *
 * @param off - OFF v2 product payload (as returned by `fetchOffProduct`)
 * @param barcode - the original query barcode (we trust this over OFF's echo)
 */
export function normalizeOffProduct(off: OffProduct, barcode: string): Product {
  const name =
    off.product_name_en?.trim() ??
    off.product_name?.trim() ??
    '';
  const brand = off.brands?.split(',')[0]?.trim() ?? '';

  const rawIngredients = parseIngredients(off);
  const ingredients: Ingredient[] = rawIngredients.map((raw) => {
    const normalized = normalizeIngredientName(raw.name);
    const { flag, reason, fertilityRelevant, testosteroneRelevant } =
      lookupIngredientFlag(normalized);

    return {
      name: raw.name,
      position: raw.position,
      flag,
      reason,
      fertility_relevant: fertilityRelevant,
      testosterone_relevant: testosteroneRelevant,
    };
  });

  const now = new Date().toISOString();

  return {
    // M1 has no DB persistence, so `id` is a deterministic synthetic value
    // derived from the barcode. M3 will replace this with the real row UUID.
    id: `off:${barcode}`,
    barcode,
    name,
    brand,
    category: inferOffCategory(off),
    image_url: off.image_front_url ?? null,
    data_completeness: determineCompleteness(name, ingredients),
    ingredient_source: 'open_food_facts',
    ingredients,
    created_at: now,
    updated_at: now,
  };
}

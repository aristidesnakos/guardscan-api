/**
 * Normalization layer.
 *
 * Turns source-specific payloads (OFF, OBF, DSLD) into the canonical `Product`
 * shape the client consumes. This is where we apply the ingredient dictionary
 * to flag each ingredient.
 *
 * Uses inline seed dictionary (~300 entries). Unknown ingredients default to
 * `neutral` per charter §13.2. M3 will swap to a DB-backed lookup.
 */

import type {
  DataCompleteness,
  Ingredient,
  IngredientFlag,
  Product,
  ProductCategory,
} from '@/types/guardscan';
import type { OffProduct } from './sources/openfoodfacts';
import type { ObfProduct } from './sources/openbeautyfacts';
import type { DsldLabel } from './sources/dsld';
import { lookupIngredient } from './dictionary/lookup';

// ── Shared helpers ──────────────────────────────────────────────────────────

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

function flagIngredients(raw: { name: string; position: number }[]): Ingredient[] {
  return raw.map((r) => {
    const normalized = normalizeIngredientName(r.name);
    const { flag, reason, fertilityRelevant, testosteroneRelevant } =
      lookupIngredientFlag(normalized);
    return {
      name: r.name,
      position: r.position,
      flag,
      reason,
      fertility_relevant: fertilityRelevant,
      testosterone_relevant: testosteroneRelevant,
    };
  });
}

function determineCompleteness(
  name: string,
  ingredients: Ingredient[],
): DataCompleteness {
  if (!name) return 'barcode_only';
  if (ingredients.length === 0) return 'partial';
  return 'full';
}

// ── Ingredient parsing (OFF/OBF shared format) ─────────────────────────────

/**
 * Parse ingredients from the OFF/OBF structured array or fall back to text.
 * Both APIs use the same representation.
 */
function parseOpenIngredients(
  product: OffProduct | ObfProduct,
): { name: string; position: number }[] {
  if (product.ingredients && product.ingredients.length > 0) {
    return product.ingredients
      .map((ing, idx) => ({
        name: (ing.text ?? ing.id ?? '').trim(),
        position: ing.rank && ing.rank > 0 ? ing.rank : idx + 1,
      }))
      .filter((ing) => ing.name.length > 0);
  }

  const text = product.ingredients_text_en ?? product.ingredients_text ?? '';
  if (!text) return [];

  return text
    .replace(/\([^)]*\)/g, '')
    .split(/[,;]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((name, idx) => ({ name, position: idx + 1 }));
}

// ── OFF normalizer ──────────────────────────────────────────────────────────

export function inferOffCategory(_off: OffProduct): ProductCategory {
  return 'food';
}

export function normalizeOffProduct(off: OffProduct, barcode: string): Product {
  const name =
    off.product_name_en?.trim() ??
    off.product_name?.trim() ??
    '';
  const brand = off.brands?.split(',')[0]?.trim() ?? '';
  const ingredients = flagIngredients(parseOpenIngredients(off));
  const now = new Date().toISOString();

  return {
    id: `off:${barcode}`,
    barcode,
    name,
    brand,
    category: inferOffCategory(off),
    subcategory: null, // Populated by inferSubcategory() at the call site
    image_url: off.image_front_url ?? null,
    data_completeness: determineCompleteness(name, ingredients),
    ingredient_source: 'open_food_facts',
    ingredients,
    created_at: now,
    updated_at: now,
  };
}

// ── OBF normalizer ──────────────────────────────────────────────────────────

export function normalizeObfProduct(obf: ObfProduct, barcode: string): Product {
  const name =
    obf.product_name_en?.trim() ??
    obf.product_name?.trim() ??
    '';
  const brand = obf.brands?.split(',')[0]?.trim() ?? '';
  const ingredients = flagIngredients(parseOpenIngredients(obf));
  const now = new Date().toISOString();

  return {
    id: `obf:${barcode}`,
    barcode,
    name,
    brand,
    category: 'grooming' as ProductCategory,
    subcategory: null,
    image_url: obf.image_front_url ?? null,
    data_completeness: determineCompleteness(name, ingredients),
    ingredient_source: 'open_food_facts',
    ingredients,
    created_at: now,
    updated_at: now,
  };
}

// ── DSLD normalizer ─────────────────────────────────────────────────────────

/**
 * Parse DSLD ingredientRows (Supplement Facts panel) and otheringredients
 * (inactive fillers, coatings) into a flat ingredient list.
 */
function parseDsldIngredients(label: DsldLabel): { name: string; position: number }[] {
  const results: { name: string; position: number }[] = [];
  let pos = 1;

  // Active ingredients from the Supplement Facts panel
  if (label.ingredientRows) {
    for (const row of label.ingredientRows) {
      results.push({ name: row.name, position: pos++ });
      // Include specific forms (e.g., "Cholecalciferol" for "Vitamin D")
      if (row.forms) {
        for (const form of row.forms) {
          results.push({ name: form.name, position: pos++ });
        }
      }
    }
  }

  // Other/inactive ingredients
  if (label.otheringredients?.ingredients) {
    for (const other of label.otheringredients.ingredients) {
      results.push({ name: other.name, position: pos++ });
    }
  } else if (label.otheringredients?.text) {
    // Fall back to splitting the raw text
    const parts = label.otheringredients.text
      .replace(/\([^)]*\)/g, '')
      .split(/[,;.]+/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    for (const name of parts) {
      results.push({ name, position: pos++ });
    }
  }

  return results;
}

export function normalizeDsldLabel(label: DsldLabel, barcode: string): Product {
  const name = label.fullName?.trim() ?? '';
  const brand = label.brandName?.trim() ?? '';
  const ingredients = flagIngredients(parseDsldIngredients(label));
  const now = new Date().toISOString();

  return {
    id: `dsld:${label.id}`,
    barcode,
    name,
    brand,
    category: 'supplement' as ProductCategory,
    subcategory: null,
    image_url: null, // DSLD does not provide images
    data_completeness: determineCompleteness(name, ingredients),
    ingredient_source: 'verified',
    ingredients,
    created_at: now,
    updated_at: now,
  };
}

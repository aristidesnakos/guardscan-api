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
  Product,
  ProductCategory,
} from '@/types/guardscan';
import type { OffProduct } from './sources/openfoodfacts';
import type { ObfProduct } from './sources/openbeautyfacts';
import type { DsldLabel } from './sources/dsld';
import {
  resolveIngredient,
  type IngredientResolveSource,
} from './dictionary/resolve';

// Re-export so existing callers (tests, scripts) keep working.
export { normalizeIngredientName } from './dictionary/resolve';

// ── Shared helpers ──────────────────────────────────────────────────────────

/**
 * Derive an English lookup key from an OFF/OBF ingredient `id` field.
 * Returns null when the id is non-English or absent.
 *
 * Format rules:
 * - "en:<slug>"  → canonical English: strip prefix, replace hyphens with spaces
 * - "<slug>"     → no colon means INCI / additive code: replace hyphens
 * - "fr:<slug>"  → non-English locale: cannot use, return null
 */
function offIdToLookupKey(id: string | undefined): string | null {
  if (!id) return null;
  if (id.startsWith('en:')) return id.slice(3).replace(/-/g, ' ');
  if (!id.includes(':')) return id.replace(/-/g, ' ');
  return null;
}

function flagIngredients(
  raw: { name: string; lookupHint?: string; position: number }[],
  source: IngredientResolveSource,
  productCategory?: ProductCategory,
): Ingredient[] {
  return raw.map((r) =>
    resolveIngredient(r.name, r.position, source, r.lookupHint, productCategory),
  );
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

/** Section headers that OFF/OBF misparse from ingredient-list images. */
const HEADER_NOISE = new Set([
  'ingredients', 'ingrédients', 'ingredientes', 'ingredienti',
  'composition', 'zusammensetzung', 'ingrediënten', 'składniki',
  'inci',
]);

function isHeaderNoise(name: string): boolean {
  return HEADER_NOISE.has(name.toLowerCase().trim());
}

/**
 * Parse ingredients from the OFF/OBF structured array or fall back to text.
 * Both APIs use the same representation.
 */
function parseOpenIngredients(
  product: OffProduct | ObfProduct,
): { name: string; lookupHint?: string; position: number }[] {
  if (product.ingredients && product.ingredients.length > 0) {
    return product.ingredients
      .map((ing, idx) => ({
        name: (ing.text ?? ing.id ?? '').trim(),
        lookupHint: offIdToLookupKey(ing.id) ?? undefined,
        position: ing.rank && ing.rank > 0 ? ing.rank : idx + 1,
      }))
      .filter((ing) => ing.name.length > 0 && !isHeaderNoise(ing.name));
  }

  const text = product.ingredients_text_en ?? product.ingredients_text ?? '';
  if (!text) return [];

  return text
    .replace(/\([^)]*\)/g, '')
    .split(/[,;]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && !isHeaderNoise(s))
    .map((name, idx) => ({ name, position: idx + 1 }));
}

// ── Category detection ───────────────────────────────────────────────────────

/** OFF/OBF category tags that indicate a grooming/personal-care product. */
const GROOMING_TAG_PREFIXES = [
  'en:body-creams', 'en:face-creams', 'en:facial-creams',
  'en:shampoos', 'en:hair-conditioners', 'en:hair-masks',
  'en:shower-gels', 'en:deodorants', 'en:soaps',
  'en:suncare', 'en:body-care', 'en:face-care',
  'en:hair-care', 'en:skin-care', 'en:moisturizers',
  'en:hand-creams', 'en:lip-balms', 'en:toothpastes',
  'en:mouthwashes', 'en:makeups', 'en:perfumes',
  'en:aftershaves', 'en:hygiene', 'en:body-milks',
  'en:body-oils', 'en:intimate-hygiene',
];

/** Multi-word keywords that strongly indicate grooming (conservative). */
const GROOMING_TEXT_KEYWORDS = [
  'moisturizing cream', 'moisturising cream', 'moisturizing lotion',
  'moisturiser', 'body lotion', 'body cream', 'face cream', 'hand cream',
  'shampoo', 'conditioner', 'shower gel', 'body wash',
  'deodorant', 'antiperspirant', 'sunscreen', 'sunblock',
  'toothpaste', 'mouthwash', 'lip balm', 'face wash', 'cleanser',
  'aftershave', 'shaving cream', 'body oil', 'body scrub',
  'hair gel', 'hair wax', 'pomade', 'beard oil', 'nail polish',
  'skin care', 'skincare', 'bar soap',
];

// ── OFF normalizer ──────────────────────────────────────────────────────────

export function inferOffCategory(off: OffProduct): ProductCategory {
  // Signal 1: categories_tags (highest confidence)
  if (off.categories_tags?.some(tag =>
    GROOMING_TAG_PREFIXES.some(p => tag.toLowerCase().startsWith(p))
  )) return 'grooming';

  // Signal 2: categories free-text
  const catsLower = (off.categories ?? '').toLowerCase();
  if (GROOMING_TEXT_KEYWORDS.some(kw => catsLower.includes(kw))) return 'grooming';

  // Signal 3: product name (lowest confidence)
  const nameLower = (off.product_name_en ?? off.product_name ?? '').toLowerCase();
  if (GROOMING_TEXT_KEYWORDS.some(kw => nameLower.includes(kw))) return 'grooming';

  return 'food'; // conservative default
}

export function normalizeOffProduct(off: OffProduct, barcode: string): Product {
  const name =
    off.product_name_en?.trim() ??
    off.product_name?.trim() ??
    '';
  const brand = off.brands?.split(',')[0]?.trim() ?? '';
  const category = inferOffCategory(off);
  const ingredients = flagIngredients(parseOpenIngredients(off), 'off', category);
  const now = new Date().toISOString();

  return {
    id: `off:${barcode}`,
    barcode,
    name,
    brand,
    category,
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
  const ingredients = flagIngredients(parseOpenIngredients(obf), 'obf', 'grooming');
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
  const ingredients = flagIngredients(parseDsldIngredients(label), 'dsld', 'supplement');
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

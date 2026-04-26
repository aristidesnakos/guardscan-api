/**
 * Ingredient dictionary lookup.
 *
 * Builds a two-tier Map at module load from the seed entries:
 *
 *   Tier 1 — composite keys `${normalized}::${category}` for category-specific
 *             lookup. Exact-category match → correct flag even when the same
 *             normalized name exists in multiple categories (e.g. titanium dioxide:
 *             food=negative, grooming=positive).
 *   Tier 2 — flat keys `${normalized}` as fallback when the caller has no product
 *             category. First writer wins, so 'both' entries (listed earliest in
 *             the seed) own the flat slot for cross-category names.
 *
 * Build-time guard: throws at module load if two seed entries share the same
 * normalized name AND the same category — the silent overwrite that caused
 * titanium dioxide to be misrepresented for food products.
 *
 * Returns the full entry or `null` (not a neutral fallback) so callers can
 * distinguish "known" from "unknown". The caller is responsible for the
 * default-to-neutral policy.
 */

import type { ProductCategory } from '@/types/guardscan';
import { SEED_ENTRIES, type DictionaryEntry } from './seed';

const INDEX = buildIndex();

function buildIndex(): Map<string, DictionaryEntry> {
  const map = new Map<string, DictionaryEntry>();
  for (const entry of SEED_ENTRIES) {
    // ── Tier 1: composite (category-specific) keys ───────────────────────────
    const compositeNorm = `${entry.normalized}::${entry.category}`;
    if (map.has(compositeNorm)) {
      throw new Error(
        `Duplicate seed entry: '${entry.normalized}' in category '${entry.category}'. ` +
          'Fix the seed before deploying.',
      );
    }
    map.set(compositeNorm, entry);
    for (const alias of entry.aliases) {
      const compositeAlias = `${alias.toLowerCase()}::${entry.category}`;
      if (!map.has(compositeAlias)) map.set(compositeAlias, entry);
    }

    // ── Tier 2: flat keys (fallback — first writer wins) ────────────────────
    if (!map.has(entry.normalized)) map.set(entry.normalized, entry);
    for (const alias of entry.aliases) {
      const a = alias.toLowerCase();
      if (!map.has(a)) map.set(a, entry);
    }
  }
  return map;
}

/**
 * Look up an ingredient by its normalized name.
 *
 * @param normalized  lowercased, whitespace-collapsed ingredient name
 * @param category    optional product category; when provided, the category-
 *                    specific entry is preferred over the flat fallback.
 *                    Entries with `category: 'both'` are also checked.
 * @returns the matching `DictionaryEntry`, or `null` if unknown.
 */
export function lookupIngredient(
  normalized: string,
  category?: ProductCategory,
): DictionaryEntry | null {
  if (category) {
    const specific = INDEX.get(`${normalized}::${category}`);
    if (specific) return specific;
    const both = INDEX.get(`${normalized}::both`);
    if (both) return both;
  }
  return INDEX.get(normalized) ?? null;
}

/** Number of unique entries (not aliases) in the dictionary. */
export const DICTIONARY_SIZE = SEED_ENTRIES.length;

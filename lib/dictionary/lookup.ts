/**
 * Ingredient dictionary lookup.
 *
 * Builds a Map at module load from the seed entries. Keyed by every
 * `normalized` name and every alias, lowercased. Returns the full entry or
 * `null` (not a neutral fallback) so callers can distinguish "known" from
 * "unknown". The caller is responsible for the default-to-neutral policy.
 */

import { SEED_ENTRIES, type DictionaryEntry } from './seed';

const INDEX = buildIndex();

function buildIndex(): Map<string, DictionaryEntry> {
  const map = new Map<string, DictionaryEntry>();
  for (const entry of SEED_ENTRIES) {
    map.set(entry.normalized, entry);
    for (const alias of entry.aliases) {
      map.set(alias.toLowerCase(), entry);
    }
  }
  return map;
}

/**
 * Look up an ingredient by its normalized name.
 *
 * @param normalized — lowercased, whitespace-collapsed ingredient name
 * @returns the matching `DictionaryEntry`, or `null` if unknown.
 */
export function lookupIngredient(normalized: string): DictionaryEntry | null {
  return INDEX.get(normalized) ?? null;
}

/** Number of unique entries (not aliases) in the dictionary. */
export const DICTIONARY_SIZE = SEED_ENTRIES.length;

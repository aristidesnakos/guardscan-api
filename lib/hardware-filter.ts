/**
 * Hardware exclusion — keeps the catalog consumable-only.
 *
 * OBF and OFF feeds include physical accessories (razors, combs, brushes,
 * trimmers, loofahs, etc.) alongside actual consumables. These have no
 * ingredient list, can't be scored, and pollute recommendations. This
 * filter runs at intake to drop them before they ever reach the DB.
 *
 * Matching rules:
 *   - Single-word keywords use word-boundary matching so `comb` won't match
 *     `combination`.
 *   - Multi-word / hyphenated phrases use plain substring matching.
 *
 * Conservative by design — false positives delete real products, so we lean
 * toward terms that are unambiguously hardware in the men's-grooming / food
 * / supplement space we serve.
 *
 * Allowlist override: products whose names describe a treatment FOR a
 * hardware-related issue ("razor bump relief", "razor burn lotion") are
 * consumables despite containing a hardware keyword. The CONSUMABLE_CONTEXT
 * list short-circuits the match.
 */

const SINGLE_WORD_HARDWARE: readonly string[] = [
  'razor',
  'razors',
  'blade',
  'blades',
  'cartridge',
  'cartridges',
  'comb',
  'combs',
  'toothbrush',
  'toothbrushes',
  'hairbrush',
  'tweezers',
  'clipper',
  'clippers',
  'trimmer',
  'trimmers',
  'shaver',
  'shavers',
  'loofah',
  'loofahs',
  'scissors',
  'shears',
];

/**
 * Phrases that prove the product is a consumable even though it mentions a
 * hardware word. Evaluated before hardware matching — any hit means "keep".
 */
const CONSUMABLE_CONTEXT: readonly string[] = [
  'razor bump',
  'razor burn',
  'razor relief',
  'post-razor',
  'after-razor',
  'post razor',
  'after razor',
];

const MULTI_WORD_HARDWARE: readonly string[] = [
  'nail file',
  'nail clipper',
  'shaving brush',
  'shave brush',
  'hair brush',
  'tooth brush',
  'makeup brush',
  'applicator brush',
  'pumice stone',
  'foot file',
  'callus remover',
  'safety razor',
  'disposable razor',
  'electric razor',
  'electric shaver',
  'electric trimmer',
  'beard trimmer',
  'body groomer',
];

function singleWordMatch(text: string, keyword: string): boolean {
  const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\b${escaped}\\b`).test(text);
}

/**
 * Returns true when the given product looks like physical hardware rather
 * than a consumable. Pass any tag strings (e.g. OBF `categories_tags`) so
 * we can catch products whose names are vague but tags are explicit
 * (`en:razors`, `en:hair-removal-tools`).
 */
export function isHardware(name: string, categoryTags?: string[]): boolean {
  const text = [name, ...(categoryTags ?? [])].join(' ').toLowerCase();
  if (!text.trim()) return false;

  // Allowlist first — "razor bump relief" is a consumable, not a razor.
  for (const phrase of CONSUMABLE_CONTEXT) {
    if (text.includes(phrase)) return false;
  }

  for (const phrase of MULTI_WORD_HARDWARE) {
    if (text.includes(phrase)) return true;
  }
  for (const word of SINGLE_WORD_HARDWARE) {
    if (singleWordMatch(text, word)) return true;
  }
  return false;
}

/** Exposed for unit tests / admin tooling. */
export const HARDWARE_KEYWORDS = {
  singleWord: SINGLE_WORD_HARDWARE,
  multiWord: MULTI_WORD_HARDWARE,
};

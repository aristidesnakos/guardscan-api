/**
 * Subcategory inference — maps product name + category to a fixed vocabulary
 * matching the Expo app's SUBCATEGORY_HINTS (lib/api.mock.ts).
 *
 * Products with no matching subcategory get null — they're excluded from
 * recommendations (no peers to cluster against).
 *
 * Matching rules:
 *   - Single-word keywords use word-boundary matching so `bar` won't match
 *     `barrel` and `milk` won't match `milkweed`.
 *   - Multi-word / hyphenated keywords use plain substring matching — the
 *     phrase itself is specific enough.
 *   - Hints are evaluated in array order; grooming entries are listed first
 *     so e.g. "Bar Soap" resolves to `soap`, never `snack_bar`.
 *
 * Adding new subcategories: just add an entry to SUBCATEGORY_HINTS below.
 * All downstream logic (alternatives, recommendations) works automatically.
 */

import type { ProductCategory } from '@/types/guardscan';

export const SUBCATEGORY_HINTS: { key: string; keywords: string[] }[] = [
  // ── Grooming ──────────────────────────────────────────────────────────────
  { key: 'sunscreen', keywords: ['sunscreen', 'spf', 'sun stick', 'sun protection', 'sun block'] },
  { key: 'shave', keywords: ['shave', 'shaving', 'razor', 'aftershave', 'pre-shave'] },
  { key: 'shampoo', keywords: ['shampoo'] },
  { key: 'conditioner', keywords: ['conditioner'] },
  { key: 'cleanser', keywords: ['cleanser', 'face wash', 'facial wash', 'facial cleanser', 'face scrub'] },
  { key: 'deodorant', keywords: ['deodorant', 'antiperspirant'] },
  { key: 'body_wash', keywords: ['body wash', 'shower gel', 'body cleanser'] },
  { key: 'moisturizer', keywords: ['moisturizer', 'moisturizing cream', 'face cream', 'lotion', 'body lotion', 'body cream', 'hand cream'] },
  { key: 'beard', keywords: ['beard oil', 'beard balm', 'beard wash'] },
  { key: 'hair_styling', keywords: ['pomade', 'hair gel', 'hair wax', 'styling'] },
  // `soap` must come before `snack_bar` so "Bar Soap" resolves correctly.
  { key: 'soap', keywords: ['soap', 'bar soap', 'hand soap'] },
  { key: 'toothpaste', keywords: ['toothpaste', 'oral care'] },
  { key: 'lip_care', keywords: ['lip balm', 'chapstick'] },
  { key: 'cologne', keywords: ['cologne', 'eau de toilette', 'body spray'] },
  // ── Food ──────────────────────────────────────────────────────────────────
  // Use specific phrases — bare `energy` collides with "Nivea Men Energy"
  // (deodorant) and bare `bar` collides with "Bar Soap", "Wood Barrel", etc.
  { key: 'drink', keywords: ['energy drink', 'electrolyte drink', 'sports drink', 'protein drink', 'meal replacement drink'] },
  { key: 'snack_bar', keywords: ['protein bar', 'energy bar', 'granola bar', 'meal bar', 'snack bar'] },
  { key: 'cereal', keywords: ['cereal', 'muesli', 'granola'] },
  { key: 'spread', keywords: ['peanut butter', 'almond butter', 'nut butter', 'nutella', 'jam', 'jelly', 'honey spread'] },
  { key: 'sauce', keywords: ['ketchup', 'mustard', 'salad dressing', 'mayonnaise', 'hot sauce', 'bbq sauce', 'pasta sauce'] },
  { key: 'meat', keywords: ['chicken', 'beef', 'pork', 'turkey', 'sausage', 'bacon', 'jerky'] },
  { key: 'dairy', keywords: ['milk', 'cheese', 'yogurt', 'yoghurt', 'cottage cheese'] },
  { key: 'nuts_seeds', keywords: ['almonds', 'peanuts', 'cashews', 'mixed nuts', 'trail mix'] },
  // ── Supplement ────────────────────────────────────────────────────────────
  { key: 'multivitamin', keywords: ['multivitamin', 'multi-vitamin'] },
  { key: 'protein', keywords: ['protein powder', 'whey', 'casein', 'protein shake'] },
  { key: 'omega', keywords: ['omega', 'fish oil', 'krill oil'] },
  { key: 'probiotic', keywords: ['probiotic', 'prebiotic'] },
  { key: 'testosterone', keywords: ['testosterone', 'test booster', 't-booster'] },
  { key: 'pre_workout', keywords: ['pre-workout', 'pre workout', 'preworkout'] },
];

/**
 * Matches a keyword against text:
 *   - Multi-word or hyphenated keywords: literal substring match (the phrase
 *     is specific enough on its own).
 *   - Single-word keywords: word-boundary regex — prevents false positives
 *     like `bar` → `barrel` or `milk` → `milkweed`.
 */
function keywordMatches(text: string, keyword: string): boolean {
  if (keyword.includes(' ') || keyword.includes('-')) {
    return text.includes(keyword);
  }
  const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\b${escaped}\\b`).test(text);
}

/**
 * Infers a subcategory from product name and category tags.
 * Returns null if no hint matches.
 */
export function inferSubcategory(
  name: string,
  _category: ProductCategory,
  categoryTags?: string[],
): string | null {
  const text = [name, ...(categoryTags ?? [])].join(' ').toLowerCase();
  for (const hint of SUBCATEGORY_HINTS) {
    if (hint.keywords.some((kw) => keywordMatches(text, kw))) {
      return hint.key;
    }
  }
  return null;
}

/**
 * Subcategory inference — maps product name + category to a fixed vocabulary
 * matching the Expo app's SUBCATEGORY_HINTS (lib/api.mock.ts).
 *
 * Products with no matching subcategory get null — they're excluded from
 * recommendations (no peers to cluster against).
 *
 * Adding new subcategories: just add an entry to SUBCATEGORY_HINTS below.
 * All downstream logic (alternatives, recommendations) works automatically.
 */

import type { ProductCategory } from '@/types/guardscan';

export const SUBCATEGORY_HINTS: { key: string; keywords: string[] }[] = [
  // Grooming — men's grooming & personal care focus
  { key: 'sunscreen', keywords: ['sunscreen', 'spf', 'sun stick', 'sun protection', 'sun block'] },
  { key: 'shave', keywords: ['shave', 'shaving', 'razor', 'aftershave', 'pre-shave', 'shaving cream'] },
  { key: 'shampoo', keywords: ['shampoo'] },
  { key: 'conditioner', keywords: ['conditioner'] },
  { key: 'cleanser', keywords: ['cleanser', 'face wash', 'facial wash', 'facial cleanser', 'face scrub'] },
  { key: 'deodorant', keywords: ['deodorant', 'antiperspirant'] },
  { key: 'body_wash', keywords: ['body wash', 'shower gel', 'body cleanser'] },
  { key: 'moisturizer', keywords: ['moisturizer', 'moisturizing cream', 'face cream', 'lotion', 'body lotion', 'body cream', 'hand cream'] },
  { key: 'beard', keywords: ['beard oil', 'beard balm', 'beard wash'] },
  { key: 'hair_styling', keywords: ['pomade', 'hair gel', 'hair wax', 'styling'] },
  { key: 'soap', keywords: ['soap', 'bar soap', 'hand soap'] },
  { key: 'toothpaste', keywords: ['toothpaste', 'oral care'] },
  { key: 'lip_care', keywords: ['lip balm', 'chapstick'] },
  { key: 'cologne', keywords: ['cologne', 'eau de toilette', 'body spray'] },
  // Food — fitness-focused
  { key: 'drink', keywords: ['energy', 'electrolyte', 'drink', 'beverage'] },
  { key: 'snack_bar', keywords: ['bar', 'protein bar', 'energy bar', 'granola bar'] },
  { key: 'cereal', keywords: ['cereal', 'muesli', 'granola'] },
  { key: 'spread', keywords: ['spread', 'butter', 'jam', 'nutella', 'peanut butter'] },
  { key: 'sauce', keywords: ['sauce', 'ketchup', 'mustard', 'dressing', 'mayo'] },
  { key: 'meat', keywords: ['chicken', 'beef', 'pork', 'turkey', 'sausage', 'bacon', 'jerky'] },
  { key: 'dairy', keywords: ['milk', 'cheese', 'yogurt', 'yoghurt', 'cottage cheese'] },
  { key: 'nuts_seeds', keywords: ['almonds', 'peanuts', 'cashews', 'mixed nuts', 'trail mix'] },
  // Supplement
  { key: 'multivitamin', keywords: ['multivitamin', 'multi-vitamin'] },
  { key: 'protein', keywords: ['protein powder', 'whey', 'casein', 'protein shake'] },
  { key: 'omega', keywords: ['omega', 'fish oil', 'krill oil'] },
  { key: 'probiotic', keywords: ['probiotic', 'prebiotic'] },
  { key: 'testosterone', keywords: ['testosterone', 'test booster', 't-booster'] },
  { key: 'pre_workout', keywords: ['pre-workout', 'pre workout', 'preworkout'] },
];

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
    if (hint.keywords.some((kw) => text.includes(kw))) {
      return hint.key;
    }
  }
  return null;
}

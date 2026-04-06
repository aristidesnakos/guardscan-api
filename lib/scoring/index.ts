/**
 * Scoring entry point.
 *
 * Routes to the appropriate scorer by product category. Supplements return
 * `null` in M1 — they're scored in M2 once DSLD ingest lands and we have
 * quality/testing signals. Callers should surface this as "supplement scoring
 * coming soon" rather than failing the scan.
 */

import type { LifeStage, Product, ScoreBreakdown } from '@/types/guardscan';
import { scoreFoodGrooming } from './food-grooming';

export { scoreFoodGrooming } from './food-grooming';
export * from './constants';

export type ScoreProductInput = {
  product: Product;
  lifeStage?: LifeStage;
  /** OFF's raw nutriscore_score for food products. Passed through to food scorer. */
  nutriscoreScore?: number;
};

export function scoreProduct({
  product,
  lifeStage,
  nutriscoreScore,
}: ScoreProductInput): ScoreBreakdown | null {
  if (product.data_completeness === 'barcode_only' || product.data_completeness === 'not_found') {
    return null;
  }
  if (product.ingredients.length === 0) {
    return null;
  }

  switch (product.category) {
    case 'food':
      return scoreFoodGrooming({ ingredients: product.ingredients, lifeStage, nutriscoreScore });
    case 'grooming':
      return scoreFoodGrooming({ ingredients: product.ingredients, lifeStage });
    case 'supplement':
      // M2: DSLD-backed 4-dimension scoring.
      return null;
    default:
      return null;
  }
}

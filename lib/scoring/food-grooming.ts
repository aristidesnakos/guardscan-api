/**
 * Food + grooming scoring (v1.2.0 — subtract-only).
 *
 * Pure function: takes an ingredient list and an optional life stage, returns a
 * complete `ScoreBreakdown`. No DB, no I/O. Tests can call this directly with
 * fixture data.
 *
 * Algorithm (matches Expo `constants/Scoring.ts`):
 *   1. Start at 100.
 *   2. Sum position-weighted deductions for caution/negative flags only.
 *      Positive flags do not contribute to the numeric score (v1.2.0 change).
 *   3. Apply life-stage multiplier to deductions for ingredients marked
 *      `fertility_relevant` or `testosterone_relevant`.
 *   4. Clamp to [0, 100].
 *   5. Emit flagged ingredient list and a single aggregate dimension.
 */

import type {
  AssessmentCoverage,
  FlaggedIngredient,
  Ingredient,
  LifeStage,
  ScoreBreakdown,
  ScoreDimension,
} from '@/types/guardscan';
import {
  FOOD_DIMENSION_WEIGHTS,
  LIFE_STAGE_MULTIPLIERS,
  SCORE_VERSION,
  getDeduction,
  getRating,
  nutriscoreToGuardScan,
} from './constants';

export type ScoreFoodGroomingInput = {
  ingredients: Ingredient[];
  lifeStage?: LifeStage;
  /** OFF's raw nutriscore_score (lower = better, range ~-15 to 40). Optional. */
  nutriscoreScore?: number;
};

export function scoreFoodGrooming({
  ingredients,
  lifeStage,
  nutriscoreScore,
}: ScoreFoodGroomingInput): ScoreBreakdown {
  const multiplier = lifeStage ? LIFE_STAGE_MULTIPLIERS[lifeStage] ?? 1.0 : 1.0;
  const personalized = multiplier !== 1.0;

  let raw = 100;
  const flagged: FlaggedIngredient[] = [];

  for (const ing of ingredients) {
    const base = getDeduction(ing.flag, ing.position);
    if (base === 0) continue;

    // Only penalize harder on sensitive flags; positive flags don't scale up.
    const sensitive = ing.fertility_relevant || ing.testosterone_relevant;
    const applied =
      sensitive && base < 0 ? Math.round(base * multiplier) : base;

    raw += applied;

    if (ing.flag === 'caution' || ing.flag === 'negative') {
      flagged.push({
        name: ing.name,
        flag: ing.flag,
        reason: ing.reason,
        position: ing.position,
        deduction: applied,
      });
    }
  }

  const ingredientSafetyScore = Math.max(0, Math.min(100, raw));

  // Sort worst-first so the UI can show the most impactful issues up top.
  flagged.sort((a, b) => a.deduction - b.deduction);

  // ── Build dimensions + compute weighted overall ─────────────────────────
  const hasNutriscore = nutriscoreScore != null && !isNaN(nutriscoreScore);
  const nutritionQualityScore = hasNutriscore
    ? nutriscoreToGuardScan(nutriscoreScore)
    : null;

  const dimensions: ScoreDimension[] = [];
  let overallScore: number;

  if (nutritionQualityScore != null) {
    // Two-dimension weighted scoring (food with Nutri-Score data)
    const nw = FOOD_DIMENSION_WEIGHTS.nutritional_quality;
    const iw = FOOD_DIMENSION_WEIGHTS.ingredient_safety;
    overallScore = Math.round(nutritionQualityScore * nw + ingredientSafetyScore * iw);

    dimensions.push({
      name: 'Nutritional Quality',
      score: nutritionQualityScore,
      weight: nw,
      description: nutriscoreDescription(nutritionQualityScore),
    });
    dimensions.push({
      name: 'Ingredient Safety',
      score: ingredientSafetyScore,
      weight: iw,
      description:
        flagged.length === 0
          ? 'No concerning ingredients detected.'
          : `${flagged.length} ingredient${flagged.length === 1 ? '' : 's'} of concern.`,
    });
  } else {
    // Single-dimension (grooming, or food without Nutri-Score)
    overallScore = ingredientSafetyScore;
    dimensions.push({
      name: 'Ingredient Safety',
      score: ingredientSafetyScore,
      weight: 1.0,
      description:
        flagged.length === 0
          ? 'No concerning ingredients detected.'
          : `${flagged.length} ingredient${flagged.length === 1 ? '' : 's'} of concern.`,
    });
  }

  overallScore = Math.max(0, Math.min(100, overallScore));
  const { label } = getRating(overallScore);

  const total = ingredients.length;
  const assessedCount = ingredients.filter((i) => i.assessed).length;
  const assessment_coverage: AssessmentCoverage = {
    total,
    assessed: assessedCount,
    percentage: total === 0 ? 0 : Math.round((assessedCount / total) * 100),
  };

  return {
    overall_score: overallScore,
    rating: label,
    score_version: SCORE_VERSION,
    scored_at: new Date().toISOString(),
    personalized,
    dimensions,
    flagged_ingredients: flagged,
    assessment_coverage,
  };
}

function nutriscoreDescription(guardScanScore: number): string {
  if (guardScanScore >= 80) return 'Excellent nutritional profile.';
  if (guardScanScore >= 60) return 'Good nutritional profile.';
  if (guardScanScore >= 40) return 'Moderate nutritional profile — room for improvement.';
  if (guardScanScore >= 20) return 'Poor nutritional profile — high in sugar, fat, or sodium.';
  return 'Very poor nutritional profile.';
}

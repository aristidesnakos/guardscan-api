/**
 * Scoring constants — single source of truth on the backend.
 *
 * Ported from the Expo app's `constants/Scoring.ts`. Any change here must be
 * mirrored there in the same PR. The recommendations contract in
 * `docs/PRODUCT-DATABASE-CHARTER.md` §13.4 covers drift prevention.
 */

import type { LifeStage, RatingLabel } from '@/types/guardscan';

// ── Rating bands ────────────────────────────────────────────────────────────

export const RATING_BANDS: { min: number; label: RatingLabel; color: string }[] = [
  { min: 80, label: 'Excellent', color: '#16A34A' },
  { min: 60, label: 'Good', color: '#65A30D' },
  { min: 40, label: 'Mediocre', color: '#EA580C' },
  { min: 0, label: 'Poor', color: '#DC2626' },
];

export function getRating(score: number): { label: RatingLabel; color: string } {
  for (const band of RATING_BANDS) {
    if (score >= band.min) return { label: band.label, color: band.color };
  }
  return { label: 'Poor', color: '#DC2626' };
}

// ── Position tiering ────────────────────────────────────────────────────────

export type PositionTier = 'high' | 'mid' | 'low';

export function positionTier(position: number): PositionTier {
  if (position <= 3) return 'high';
  if (position <= 8) return 'mid';
  return 'low';
}

// ── Flag deductions (food + grooming) ───────────────────────────────────────

export const FLAG_DEDUCTIONS: Record<string, Record<PositionTier, number>> = {
  negative: { high: -15, mid: -10, low: -5 },
  caution: { high: -8, mid: -5, low: -3 },
  positive: { high: 5, mid: 3, low: 2 },
  neutral: { high: 0, mid: 0, low: 0 },
};

export function getDeduction(flag: string, position: number): number {
  const tier = positionTier(position);
  return FLAG_DEDUCTIONS[flag]?.[tier] ?? 0;
}

// ── Life stage multipliers ──────────────────────────────────────────────────

// TODO(multi-brand): Multipliers are keyed to the Mangood LifeStage enum.
// Pomenatal's multipliers will differ — some ingredients neutral for adult
// men are dangerous during pregnancy (retinoids, high-dose vitamin A, etc.).
// Likely refactor: pass a brand-scoped multiplier map through the scoring
// call instead of reading this global constant. See docs/multi-brand-migration.md.
export const LIFE_STAGE_MULTIPLIERS: Record<LifeStage, number> = {
  actively_trying_to_conceive: 1.5,
  testosterone_optimization: 1.3,
  longevity_focus: 1.2,
  athletic_performance: 1.0,
  general_wellness: 1.0,
};

// ── Supplement dimension weights (M2) ───────────────────────────────────────

export const SUPPLEMENT_DIMENSIONS = [
  { key: 'third_party_testing', label: 'Third-Party Testing & Quality', weight: 0.3 },
  { key: 'ingredient_efficacy', label: 'Ingredient Efficacy', weight: 0.25 },
  { key: 'contaminant_risk', label: 'Contaminant Risk', weight: 0.25 },
  { key: 'formulation_integrity', label: 'Formulation Integrity', weight: 0.2 },
] as const;

export const MIN_DIMENSIONS_FOR_SCORE = 2;

// ── Recommendations ranking threshold (contract with client) ────────────────

/**
 * Minimum score delta between a scanned (Poor/Mediocre) product and its proposed
 * alternative. Mirrors `MIN_SCORE_DELTA` in the Expo app's
 * `constants/Recommendations.ts`. Used by the M2.5 recommendations endpoint.
 */
export const MIN_SCORE_DELTA = 15;

// ── Food scoring dimension weights ──────────────────────────────────────────

/**
 * When OFF provides Nutri-Score data, food scoring uses two dimensions:
 *   - Nutritional Quality (60%) — derived from OFF's nutriscore_score
 *   - Ingredient Safety (40%) — flag-based deductions
 *
 * When nutriscore data is absent, ingredient safety is weighted at 100%.
 * Grooming products always use ingredient safety at 100% (no nutriscore).
 */
export const FOOD_DIMENSION_WEIGHTS = {
  nutritional_quality: 0.6,
  ingredient_safety: 0.4,
} as const;

/**
 * Converts OFF's nutriscore_score (range: roughly -15 to 40, lower = better)
 * to a 0-100 GuardScan scale (higher = better).
 *
 * Mapping: -15 → 100, 0 → 73, 10 → 55, 20 → 36, 31 → 16, 40 → 0
 */
export function nutriscoreToGuardScan(nutriscoreScore: number): number {
  // Linear mapping over the [-15, 40] range to [100, 0]
  const score = Math.round(100 - ((nutriscoreScore + 15) / 55) * 100);
  return Math.max(0, Math.min(100, score));
}

// ── Scoring version (stamped on every scoring output) ───────────────────────

export const SCORE_VERSION = 'v1.1.0';

/**
 * M5.1 — Outcome rubric (hormone_hijack + t_suppressor axes).
 *
 * Pure function: takes a resolved ingredient list and emits per-axis severity
 * + rendered OutcomeLine[]. No I/O. Composable for the future M6 supplement
 * scoring path (which will compute its own outcome axes against the same shape).
 *
 * ─── Starter thresholds (pre-G3 calibration) ──────────────────────────────
 * Per docs/product/FEATURES/M5-DEFENSE-LAYER.md §G3, severity caps:
 *   ≤15% of corpus may earn `severe` on any single axis.
 *   ≤30% may earn `flagged`. ≥55% must be `clear`.
 *
 * The thresholds below are the starter rubric. The G3 gate requires running
 * this against the 532-product corpus and tightening thresholds (e.g. raise
 * `EDC_TOP_N_FOR_SEVERE` from 5 to 3, or require 3 EDCs instead of 2) until
 * the cap holds. Final calibrated values + dated rationale go in
 * docs/scoring/outcome-rubric.md before the rescore lands in production.
 *
 * ─── Definition of "EDC ingredient" for hormone_hijack ────────────────────
 * Caution/negative-flagged ingredient with `endocrine_disruptor` or
 * `reproductive_toxin` in `health_risk_tags`. We do NOT include positive- or
 * neutral-flagged ingredients (the dictionary's hazard tags are descriptive;
 * the flag is what marks consumer concern). We do NOT use `fertility_relevant`
 * alone because the dictionary marks many non-EDC ingredients fertility-relevant
 * (e.g. trans fats, excess sugar) and using it would over-flag.
 */

import type {
  Ingredient,
  OutcomeFlags,
  OutcomeLine,
  OutcomeSeverity,
} from '@/types/guardscan';

// ── Starter thresholds (calibrate per G3 gate) ──────────────────────────────

const EDC_HAZARD_TAGS = ['endocrine_disruptor', 'reproductive_toxin'] as const;

/** Position cutoff for "top-3" — used in `severe` thresholds. */
const TOP_HIGH = 3;
/** Position cutoff for "top-5" — used in `severe` thresholds. */
const TOP_MID = 5;

/** ≥N EDC ingredients at top-MID OR ≥1 EDC at top-HIGH triggers `severe`. */
const EDC_COUNT_FOR_SEVERE_AT_TOP_MID = 2;

// ── Predicates ──────────────────────────────────────────────────────────────

function isEdc(ing: Ingredient): boolean {
  if (ing.flag !== 'caution' && ing.flag !== 'negative') return false;
  return ing.health_risk_tags.some((t) =>
    (EDC_HAZARD_TAGS as readonly string[]).includes(t),
  );
}

function isTSuppressor(ing: Ingredient): boolean {
  if (!ing.testosterone_relevant) return false;
  return ing.flag === 'caution' || ing.flag === 'negative';
}

// ── Per-axis classifiers ────────────────────────────────────────────────────

type AxisResult = {
  severity: OutcomeSeverity;
  contributors: Ingredient[];
};

function classifyHormoneHijack(ingredients: Ingredient[]): AxisResult {
  const edcs = ingredients.filter(isEdc);
  if (edcs.length === 0) return { severity: 'clear', contributors: [] };

  const edcsAtTopHigh = edcs.filter((i) => i.position <= TOP_HIGH);
  const edcsAtTopMid = edcs.filter((i) => i.position <= TOP_MID);

  if (edcsAtTopHigh.length >= 1 || edcsAtTopMid.length >= EDC_COUNT_FOR_SEVERE_AT_TOP_MID) {
    return { severity: 'severe', contributors: edcs };
  }
  return { severity: 'flagged', contributors: edcs };
}

function classifyTSuppressor(ingredients: Ingredient[]): AxisResult {
  const ts = ingredients.filter(isTSuppressor);
  if (ts.length === 0) return { severity: 'clear', contributors: [] };

  const negativeAtTopMid = ts.filter(
    (i) => i.flag === 'negative' && i.position <= TOP_MID,
  );

  if (negativeAtTopMid.length >= 1) {
    return { severity: 'severe', contributors: ts };
  }
  return { severity: 'flagged', contributors: ts };
}

// ── Reason copy (FE chip + drawer surface) ──────────────────────────────────
//
// Kept terse — single sentence each. FE renders below the chip; combined
// "Why these flags?" drawer pulls contributing_ingredient_names for receipts.

function reasonHormoneHijack(severity: OutcomeSeverity, contributors: Ingredient[]): string {
  if (severity === 'clear') return 'No endocrine-disrupting ingredients detected.';
  const topMost = contributors.reduce(
    (a, b) => (a.position <= b.position ? a : b),
    contributors[0],
  );
  if (severity === 'severe') {
    return `Endocrine-disrupting ingredient at position ${topMost.position} (${topMost.name}).`;
  }
  return `Contains ${contributors.length} endocrine-disrupting ingredient${contributors.length === 1 ? '' : 's'}.`;
}

function reasonTSuppressor(severity: OutcomeSeverity, contributors: Ingredient[]): string {
  if (severity === 'clear') return 'No testosterone-suppressing ingredients detected.';
  if (severity === 'severe') {
    const topMost = contributors.reduce(
      (a, b) => (a.position <= b.position ? a : b),
      contributors[0],
    );
    return `Testosterone-suppressing ingredient at position ${topMost.position} (${topMost.name}).`;
  }
  return `Contains ${contributors.length} testosterone-relevant ingredient${contributors.length === 1 ? '' : 's'}.`;
}

// ── Public API ──────────────────────────────────────────────────────────────

export type ComputeOutcomesInput = {
  ingredients: Ingredient[];
};

export type ComputeOutcomesOutput = {
  outcome_flags: OutcomeFlags;
  outcome_lines: OutcomeLine[];
};

/**
 * Compute outcome flags + lines for a resolved ingredient list.
 *
 * Invariants:
 *  - Always returns both axes (no missing keys) — UI can rely on shape.
 *  - `outcome_lines` is sorted severe → flagged → clear so FE renders worst-first.
 *  - `study_link` is currently never populated (mandatory only at `severe`,
 *    requires per-rubric study URLs — wire up alongside G3 calibration).
 */
export function computeOutcomes({ ingredients }: ComputeOutcomesInput): ComputeOutcomesOutput {
  const hormone = classifyHormoneHijack(ingredients);
  const t = classifyTSuppressor(ingredients);

  const outcome_flags: OutcomeFlags = {
    hormone_hijack: hormone.severity,
    t_suppressor: t.severity,
  };

  const lines: OutcomeLine[] = [
    {
      category: 'hormone_hijack',
      severity: hormone.severity,
      reason: reasonHormoneHijack(hormone.severity, hormone.contributors),
      contributing_ingredient_positions: hormone.contributors
        .map((i) => i.position)
        .sort((a, b) => a - b),
    },
    {
      category: 't_suppressor',
      severity: t.severity,
      reason: reasonTSuppressor(t.severity, t.contributors),
      contributing_ingredient_positions: t.contributors
        .map((i) => i.position)
        .sort((a, b) => a - b),
    },
  ];

  const severityRank: Record<OutcomeSeverity, number> = { severe: 0, flagged: 1, clear: 2 };
  lines.sort((a, b) => severityRank[a.severity] - severityRank[b.severity]);

  return { outcome_flags, outcome_lines: lines };
}

/**
 * Backfill outcome_flags + outcome_lines onto a legacy `ScoreBreakdown` blob
 * cached before this commit landed. Used by hydration paths that read pre-M5.1
 * `score_breakdown` jsonb rows. Returns the input unchanged if already populated.
 */
export function withOutcomes<T extends { outcome_flags?: OutcomeFlags; outcome_lines?: OutcomeLine[] }>(
  score: T,
  ingredients: Ingredient[],
): T & { outcome_flags: OutcomeFlags; outcome_lines: OutcomeLine[] } {
  if (score.outcome_flags && score.outcome_lines) {
    return score as T & { outcome_flags: OutcomeFlags; outcome_lines: OutcomeLine[] };
  }
  const computed = computeOutcomes({ ingredients });
  return {
    ...score,
    outcome_flags: score.outcome_flags ?? computed.outcome_flags,
    outcome_lines: score.outcome_lines ?? computed.outcome_lines,
  };
}

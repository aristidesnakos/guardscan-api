# Scoring Redesign Report — v1.2 Subtract-Only

**Status:** Approved
**Date:** 2026-04-11 (investigation) / 2026-04-12 (decisions finalized)
**Author:** Investigation triggered by user report on Sanex Expert Skin Health Protector (barcode `8718951594883`)
**Product:** ManGood
**Related:** [scoring.md](./scoring.md), [lib/scoring/food-grooming.ts](../../lib/scoring/food-grooming.ts), [lib/dictionary/seed.ts](../../lib/dictionary/seed.ts)

---

## 1. Executive Summary

The current scoring algorithm (v1.1.0) can silently mask caution and negative ingredients when a product's early-position ingredients trigger positive flags. The result is a final score that looks perfect (100/100) even though the breakdown itself records the flagged ingredients. This is not a data bug — it is a design flaw in how positive and negative contributions are pooled.

This report:

1. Documents the bug with a real-world reproduction.
2. Explains why it is systemic, not incidental.
3. Recommends a scoring redesign (**v1.2.0 — subtract-only**) that aligns with toxicological best practice and with how competitor apps (Yuka, INCI Beauty, Think Dirty, EWG Skin Deep) actually work.
4. Defines explicit scope boundaries — in particular, **no noisy positive callouts for baseline formulation ingredients**.

---

## 2. Findings

### 2.1 The reported case

| Field | Value |
|---|---|
| Product | Expert Skin Health Protector Hydrating Technology Shower Gel |
| Brand | Sanex |
| Barcode | `8718951594883` |
| Category | grooming / body_wash |
| Source | user (auto-published from submission) |
| Stored score | **100** |
| Competitor score | 86 |
| Flagged ingredients in stored breakdown | 2 (Sodium Benzoate, Parfum) |

The submission pipeline ([app/api/products/submit/route.ts](../../app/api/products/submit/route.ts)) ran as designed. Claude OCR extracted 19 ingredients, auto-publish confidence passed, and [lib/submissions/auto-publish.ts](../../lib/submissions/auto-publish.ts) invoked the shared `scoreProduct` path. Nothing was submitted raw — the 100 was computed by the scoring function from correctly-classified ingredients.

### 2.2 The math

`scoreFoodGrooming` at [lib/scoring/food-grooming.ts:48-73](../../lib/scoring/food-grooming.ts#L48-L73) starts `raw = 100` and iterates ingredients:

| Pos | Ingredient | Flag | Tier | Delta | Running |
|---|---|---|---|---|---|
| 1 | Aqua | positive | high | +5 | 105 |
| 4 | Glycerin | positive | mid | +3 | 108 |
| 5 | Sodium Benzoate | caution | mid | −5 | 103 |
| 6 | Lactic Acid | positive | mid | +3 | 106 |
| 7 | Parfum | caution | mid | −5 | **101** |

Then:

```ts
const ingredientSafetyScore = Math.max(0, Math.min(100, raw));
```

`Math.min(100, 101) = 100`. The two `−5` deductions are faithfully recorded in `flagged_ingredients` — which is why the stored breakdown contains both `{deduction: -5}` entries alongside `overall_score: 100`. The dimension description even says *"2 ingredients of concern."* next to a perfect score.

### 2.3 Root cause

Two compounding design choices:

1. **Positives and negatives are pooled additively into one accumulator.** `raw += applied` runs for both deduction-style and credit-style flags. A product with any high- or mid-position positive ingredient gets an immediate buffer that absorbs cautions invisibly.
2. **The clamp at 100 hides the overshoot.** Once `raw > 100`, the algorithm cannot distinguish "perfect product" from "flawed product with enough filler credit to paper over its flaws." Both present as 100.

### 2.4 Scope of impact

This affects the entire grooming category, not just Sanex. The positive dictionary currently includes baseline formulation ingredients that appear in virtually every personal-care product: Water/Aqua, Glycerin, Lactic Acid, and similar humectants/solvents/pH adjusters. Any grooming product whose first-five ingredients include two or more of these starts with a hidden +6 to +11 credit buffer before the first caution is even counted.

Conservatively, this likely causes systematic **2–10 point inflation** on most scored grooming products. Products with Yuka-equivalent scores in the 80s frequently land at 90+ in ManGood, and mid-80s products can silently round up to 100.

The same scoring file is used for food via [lib/scoring/food-grooming.ts](../../lib/scoring/food-grooming.ts), so the bug also affects the Ingredient Safety dimension of food scoring — though its impact there is diluted because food scores are 60% Nutri-Score + 40% ingredient safety.

### 2.5 What is not the cause

- **Not** an auto-publish guardrail miss. Guardrails gate whether to publish, not how to score.
- **Not** a `source='user'` bypass. [lib/cron/ingest-helpers.ts:50-51](../../lib/cron/ingest-helpers.ts#L50-L51) writes whatever `scoreProduct` returns with no source-specific branching.
- **Not** from the rescore script. [scripts/rescore-products.ts](../../scripts/rescore-products.ts) has an `isNull(products.score)` guard on both its SELECT and UPDATE and will not touch an already-scored row.
- **Not** an OCR error. Claude extracted the ingredients correctly; the dictionary classified them correctly; the bug is downstream of both.

---

## 3. Why Subtract-Only is the Right Fix

### 3.1 Scientific framing

Ingredient **safety** and ingredient **efficacy / benefit** are two independent dimensions in toxicology. Risk assessment enumerates hazards; it does not credit benign ingredients as offsetting those hazards. The presence of water does not neutralize a phthalate. Conflating the two dimensions produces the exact artifact we observed: a product can "offset" a real concern with filler credit.

A subtract-only safety score represents a defensible, communicable claim:

> *100 means no known concerns were detected at meaningful positions. Lower scores reflect the severity and concentration of detected concerns.*

This is a claim we can stand behind under scrutiny. The current algorithm's claim — *100 means this product has enough good ingredients to outweigh its flagged ones* — is not defensible and does not match any regulatory or academic risk framework.

### 3.2 Competitor alignment

All major consumer ingredient-scoring apps use subtract-only or subtract-equivalent models for safety:

| App | Model |
|---|---|
| Yuka | Subtract from 100; worst ingredient also caps the maximum |
| INCI Beauty | Subtract from 20 (equivalent scale) |
| Think Dirty | Subtract from 10 (equivalent scale) |
| EWG Skin Deep | Hazard level enumeration, not credit-based |

None credit baseline ingredients like water as positive contributions to a safety score. Users comparing ManGood to these apps will see the alignment immediately, and our scores will no longer systematically inflate relative to the competitive set.

### 3.3 Honest caveat

None of these systems — ours included — are rigorous toxicology. Real risk assessment requires concentration, formulation context, route of exposure, frequency, bioavailability, and individual susceptibility. Position in an INCI list is a rough proxy for concentration. Binary flags collapse nuance. Subtract-only is not *scientifically accurate* in an absolute sense; it is **the least-wrong heuristic** available for a consumer-facing safety score, and it is the one the field has converged on.

---

## 4. Recommendation — Scoring v1.2.0

### 4.1 Algorithm changes

1. **Drop positive contributions from the numeric score entirely.** The `FLAG_DEDUCTIONS.positive` row in [lib/scoring/constants.ts](../../lib/scoring/constants.ts) becomes `{ high: 0, mid: 0, low: 0 }` or is removed from the deduction path altogether.
2. **Score accumulator only decreases.** `raw = 100; for ing: if deduction < 0 then raw += deduction`. The `Math.max(0, ...)` clamp stays; the `Math.min(100, ...)` clamp becomes unnecessary (it can stay defensively).
3. **Bump `SCORE_VERSION` to `v1.2.0`** in [lib/scoring/constants.ts](../../lib/scoring/constants.ts#L115). Score version is already stamped on every output, so the app can detect legacy-scored products and trigger rescores.
4. **Mirror the change in the Expo app's `constants/Scoring.ts`.** Per the `CLAUDE.md` charter, any scoring constants change must be mirrored client-side in the same PR to prevent drift.

### 4.2 Dictionary cleanup — no noisy positive callouts

This is explicit and non-negotiable: **baseline formulation ingredients must not generate user-facing positive callouts of any kind.** A "this product contains water" message does not serve the user, damages our credibility, and adds noise to the UI.

Concretely:

- **Prune the positive flag from baseline ingredients** in [lib/dictionary/seed.ts](../../lib/dictionary/seed.ts). This includes but is not limited to: Water/Aqua, Glycerin, Lactic Acid (at formulation-base concentrations), Tocopherol when used as a preservative antioxidant, and any ingredient whose "benefit" is actually "it is a standard formulation base." These become `neutral`.
- **Preserve the positive flag only for genuine actives** with meaningful consumer signal: documented bioactive compounds like niacinamide, hyaluronic acid, retinol at therapeutic concentrations, vitamin C in stable forms, salicylic acid in treatment products, etc. Even these should not contribute to the numeric score — they are preserved as data for future use, not for display today.
- **Do not ship a "What's good" UI in v1.2.** The user direction is clear: no positive callouts. If we add such a UI in a future version, it must be gated on a curated actives list, not on the full positive-flag dictionary. For v1.2 the positive data is dormant — present in the dictionary, absent from both the score and the UI.

### 4.3 What the v1.2 breakdown looks like

For the same Sanex product:

```
ingredients iterated:
  Sodium Benzoate (pos 5, caution, mid) → −5    raw = 95
  Parfum          (pos 7, caution, mid) → −5    raw = 90

overall_score: 90
rating: Excellent (still above the 80 band)
flagged_ingredients: [Sodium Benzoate, Parfum]
```

Closer to the competitor's 86, internally consistent (score matches the flagged list), and defensible.

---

## 5. Implementation Plan

Each step is self-contained and reversible via a score version bump.

### Step 1 — Backend algorithm

- Edit [lib/scoring/food-grooming.ts](../../lib/scoring/food-grooming.ts) to skip positive flags in the accumulator. Keep the loop's flagged-list side effect unchanged so caution/negative data continues to flow through.
- Edit [lib/scoring/constants.ts](../../lib/scoring/constants.ts): zero out `FLAG_DEDUCTIONS.positive` (preferred) and bump `SCORE_VERSION` to `v1.2.0`.
- **Remove** existing positive-flag test fixtures entirely (not update — delete). Simplify.
- Add a regression test using the Sanex ingredient list that asserts `overall_score === 90`.

### Step 2 — Dictionary prune

- Walk [lib/dictionary/seed.ts](../../lib/dictionary/seed.ts) and reclassify baseline formulation positives to `neutral`. At minimum: `water`/`aqua`, `glycerin`, `lactic acid`. Audit the full positive list and apply the rule *"does a consumer learn anything by being told this product contains X?"* — if no, neutral.
- Leave genuine actives flagged as positive in the dictionary for future use. They will not affect scores in v1.2.

### Step 3 — Rescore sweep

- Write a one-off script `scripts/rescore-v1.2.ts` (adapted from `rescore-products.ts`) that:
  - Selects all products where `score_breakdown->>'score_version' != 'v1.2.0'` OR `score_version IS NULL`.
  - Reconstructs the `Product` from `product_ingredients`.
  - Re-runs `scoreProduct` and writes back `score` + `score_breakdown`.
  - Supports `--dry` and `--limit` flags.
  - Logs a summary of score deltas (expected: net negative drift across the grooming category).
  - Includes a **band-transition counter** in the summary output (e.g., "Excellent->Good: 3, Good->Mediocre: 0") for quick impact sanity-checking. No separate audit needed for MVP.
- Run on staging first; spot-check a sample of 20 rows across both categories before running in production.

### Step 4 — Expo app mirror

- Update `constants/Scoring.ts` in the Expo repo with the same constants and algorithm changes in a coordinated PR.
- Ship the Expo update and backend update together, or ship the backend first (since on-device scores get overwritten by backend scores on the next scan).
- Verify the client-side locally-scored path (if any — check `data_completeness` branch) matches the backend output.

### Step 5 — Docs

- Update [docs/architecture/scoring.md](./scoring.md) to reflect v1.2.0:
  - Remove the "+5/+3/+2" column from the position tier table.
  - Reword the Ingredient Flags section to explain that positive flags exist in the dictionary but do not contribute to the score.
  - Update the "How ManGood Compares to Yuka" table to reflect the converged approach.
- Update the `CLAUDE.md` scoring-algorithm summary to match.

---

## 6. Out of Scope

- **New UI for highlighting beneficial ingredients.** Not shipping in v1.2. If we revisit in the future, it must be gated on a curated actives-only list, never on the raw positive-flag dictionary.
- **Recalibrating deduction magnitudes.** The current −15/−10/−5 (negative) and −8/−5/−3 (caution) ladders are out of scope. A dedicated calibration pass can follow once v1.2 is in production and we have drift data vs. competitors.
- **Supplement scoring.** Untouched. Supplements still return `null` pending M2.
- **Food Nutri-Score conversion.** Untouched. The 60/40 split and the nutriscore-to-ManGood mapping remain as-is.

---

## 7. Resolved Questions

1. **Should the positive-flag data stay in the dictionary?** **Yes — keep the data, stop using it.** Reclassify baseline formulation ingredients (Water, Glycerin, Lactic Acid, etc.) to `neutral`. Preserve genuine actives as `positive` in the dictionary for potential future use. They will not affect scores or UI in v1.2. *(Decided 2026-04-12)*

2. **Should food and grooming use different flag-deduction ladders?** **No — keep one shared ladder.** The per-category risk distinction already lives in the dictionary: each seed entry has a `category` field (`food`, `grooming`, `both`), so the same ingredient can carry different flags in different contexts. An ingredient that's `caution` in food but benign in grooming gets two separate dictionary entries with different flags — the deduction ladder doesn't need to branch. One ladder means `caution` at mid-position always equals −5 regardless of category, which is simpler to reason about and maintain. If future calibration reveals food cautions should hit harder than grooming cautions, the right fix is stricter flag classification in the dictionary, not a second ladder. *(Decided 2026-04-12)*

3. **Do we need a band-transition audit?** **Lightweight only — built into the rescore script.** Since ManGood is in MVP with no external score commitments, a standalone audit process is overkill. The rescore script will include a band-transition summary in its output (e.g., "Excellent->Good: 3 products, Good->Mediocre: 0") so we can sanity-check the impact in one glance. No separate report or communication needed. *(Decided 2026-04-12)*

---

## 8. Decision

Proceeding with **Option 3 — subtract-only** per discussion on 2026-04-11, decisions finalized 2026-04-12. The next step is Step 1 of the implementation plan (backend algorithm changes), followed by the rescore sweep, followed by the coordinated Expo release.

Additional decisions:
- **Branding:** All new documentation uses "ManGood" (replaces "GuardScan"). Codebase rename is a separate task.
- **Test fixtures:** Remove positive-flag test fixtures entirely rather than updating expected values. Simplify.
- **Architecture:** `food-grooming.ts` stays as one file for both categories. The function is pure (no side effects), and the only food-vs-grooming difference is the optional Nutri-Score dimension. Splitting would duplicate the core deduction loop without benefit.
- **Auto-publish confidence threshold:** Raised from 85 to 90 (separate change, already applied).

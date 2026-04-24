# Assessment Coverage Fix — Honest Neutral Handling

**Status:** Proposal (revised)
**Created:** 2026-04-23
**Scope:** Backend (guardscan-api) + Frontend (cucumberdude)
**Refs:** [DATA-QUALITY-ANALYSIS.md](../../../cucumberdude/docs/product/DATA-QUALITY-ANALYSIS.md), [INGREDIENT-DETAIL-IMPROVEMENTS.md](../../../cucumberdude/docs/product/FEATURES-PLANNED/INGREDIENT-DETAIL-IMPROVEMENTS.md)

---

## Problem

The ingredient dictionary has 148 entries. A typical grooming product contains 15–30 ingredients. Ingredients not in the dictionary resolve to `flag: 'neutral'` with an empty reason. This collapses two distinct states into one:

| State | Meaning |
|---|---|
| **Known neutral** | In the dictionary, explicitly assessed as safe (e.g. water, glycerin). |
| **Unassessed** | Not in the dictionary. Zero data. Charter still requires neutral-for-scoring, but the UX should not claim it is "assessed." |

Consequence: a product with 2 caution ingredients + 20 unassessed ingredients scores the same as one with 2 caution + 20 known-safe, and both are shown identically in the UI.

The signal already exists — `lookupIngredient()` returns `null` for unknowns at `lib/dictionary/lookup.ts:31`. We just stop throwing it away.

---

## What ships in this proposal

Everything below is additive, backwards compatible, and can land in a single PR. No scoring changes. No alias curation. No dictionary growth. No coverage percentage in the UI.

### 1. Unify the lookup path (fix a live inconsistency first)

Two callers today normalize and look up ingredients independently, with different logic:

| Call site | Normalization applied |
|---|---|
| `lib/normalize.ts:26` (OFF/OBF/DSLD path) | `normalizeIngredientName()` — strips parens, percentages, footnote marks, leading underscores, collapses whitespace. |
| `lib/submissions/auto-publish.ts:60` (user submissions) | `name.toLowerCase().trim()` only. |

User-submitted products miss dictionary entries the OFF path would hit. Before adding any new fields, extract a single shared function:

```ts
// lib/dictionary/resolve.ts (new, ~20 lines)
import { lookupIngredient } from './lookup';
import { normalizeIngredientName } from '../normalize';
import type { Ingredient } from '@/types/guardscan';

export function resolveIngredient(rawName: string, position: number): Ingredient {
  const entry = lookupIngredient(normalizeIngredientName(rawName));
  return {
    name: rawName,
    position,
    flag: entry?.flag ?? 'neutral',
    reason: entry?.reason ?? '',
    fertility_relevant: entry?.fertility_relevant ?? false,
    testosterone_relevant: entry?.testosterone_relevant ?? false,
    assessed: entry !== null,
  };
}
```

Both `flagIngredients` in `normalize.ts` and `resolveIngredients` in `auto-publish.ts` become one-line wrappers around a `.map(resolveIngredient)`. `normalizeIngredientName` moves out of `normalize.ts` into the same file, or both import it from one place. This eliminates the divergence permanently.

### 2. Add `assessed` to `Ingredient`

```ts
// types/guardscan.ts
export type Ingredient = {
  name: string;
  position: number;
  flag: IngredientFlag;
  reason: string;
  fertility_relevant: boolean;
  testosterone_relevant: boolean;
  assessed: boolean; // NEW — true iff found in dictionary
};
```

Rationale for `boolean` over a new `'unknown'` flag value: scoring stays untouched, the safety verdict (`flag`) and the data-availability signal (`assessed`) are separate concerns, and every existing Expo code path safely ignores the field until it reads it.

### 3. Add `assessment_coverage` to `ScoreBreakdown`

```ts
assessment_coverage: {
  total: number;       // ingredients.length
  assessed: number;    // ingredients.filter(i => i.assessed).length
  percentage: number;  // 0 when total === 0 (no NaN)
};
```

Computed once inside the scoring function. The client receives it but does **not** render a percentage yet — see §5 and the explicit non-goals.

### 4. Log unassessed ingredient names (structured logs, no schema change)

On every cache miss, every scan, and every submission, when `resolveIngredient` returns `assessed: false`, emit a single structured log line:

```ts
logger.info('ingredient_unassessed', {
  raw: rawName,
  normalized,
  source: 'off' | 'obf' | 'dsld' | 'submission',
});
```

Vercel already collects these. No new table. No new infrastructure. After a week of production traffic, `grep | sort | uniq -c | sort -rn` gives the real top-N miss list, which is the input to any future alias/dictionary work. Everything currently projected in the old proposal's impact table becomes a measurable number instead of a guess.

### 5. Frontend: differentiate unassessed from neutral

One visual change, one copy change, one layout change. No percentage, no banners, no thresholds.

**`components/IngredientFlag.tsx`** — when `assessed === false`:

| State | Dot | Label |
|---|---|---|
| Known neutral | Gray solid | "Neutral" |
| Unassessed (`assessed: false`) | Light gray, dashed outline | "No data" |
| Positive / Caution / Negative | unchanged | unchanged |

**Detail sheet copy** for unassessed: "This ingredient is not yet in our database. We cannot assess its safety profile."

**Collapsible groups** in the product detail page:

1. Flagged (always visible): negative + caution.
2. Assessed — risk-free (collapsed): `assessed: true` with `flag` in `{neutral, positive}`.
3. Not yet assessed (collapsed): `assessed: false`.

That's the whole UX change. The product detail page shows no coverage number until telemetry tells us what a reasonable threshold looks like.

### 6. Handle products with zero ingredients

When `data_completeness === 'partial'` (ingredients list is empty), skip the three-group split entirely — the existing "Add ingredients" CTA already handles this case. `assessment_coverage` serializes as `{ total: 0, assessed: 0, percentage: 0 }` so no NaN reaches the client.

---

## What this proposal explicitly does not do

Each of these was in the original draft; each was either speculative, out of scope, or high-risk. They come back as separate, smaller proposals once §4 has produced real data.

| Dropped | Reason |
|---|---|
| Surface coverage % in the UI with <30% / 30–74% / ≥75% thresholds | Current median coverage would trigger the alarming variant on most products. Ship telemetry first, pick thresholds from measured distribution. |
| Alias expansion per-entry (3–5 × 148) | Normalization already handles most of the original examples (parens, percentages). Real misses will be in the §4 logs; curate against that list. |
| Fuzzy / Levenshtein matching | False matches on chemical names are worse than misses. "Phenol" and "phenoxyethanol" are three edits apart. |
| Multi-pass synonym-table lookup | Not justified before §4 tells us what we're missing. |
| Claude-Vision-generated alias pairs | Interesting idea, separate proposal, needs a review process. |
| Batch LLM enrichment of new dictionary entries with flags | Hallucinated `caution`/`negative` is a trust incident. Separate proposal, needs human review policy. |
| Coverage-weighted score dimming / rating-band gating | Scoring change, v1.3.0, not this PR. |
| 4×3 impact projection table | No baseline; unfalsifiable. Projections return when §4 provides the numerator. |

---

## Files touched

### Backend (guardscan-api)

| File | Change |
|---|---|
| `types/guardscan.ts` | `Ingredient.assessed`, `ScoreBreakdown.assessment_coverage` |
| `lib/dictionary/resolve.ts` *(new)* | Shared `resolveIngredient()` — single lookup path |
| `lib/normalize.ts` | `flagIngredients` delegates to `resolveIngredient`; export `normalizeIngredientName` (or move it) |
| `lib/submissions/auto-publish.ts` | `resolveIngredients` delegates to `resolveIngredient` |
| `lib/scoring/food-grooming.ts` | Compute `assessment_coverage` |
| `lib/logger.ts` (wherever) | Emit `ingredient_unassessed` log line from `resolveIngredient` |

### Frontend (cucumberdude)

| File | Change |
|---|---|
| `types/guardscan.ts` | Mirror `assessed` + `assessment_coverage` |
| `components/IngredientFlag.tsx` | "No data" variant for `assessed: false` |
| `components/IngredientDetailModal.tsx` / `IngredientDetailSheet.tsx` | Copy for unassessed |
| `app/product/[id].tsx` | Three-group collapsible; skip split when `ingredients.length === 0` |

No DB schema change. No scoring constant change. No dictionary seed change.

---

## Data pipeline after this change

```
raw ingredient name (from OFF | OBF | DSLD | user submission)
        │
        ▼
normalizeIngredientName()       ← one function, one call site (resolveIngredient)
        │
        ▼
lookupIngredient(normalized)
        │
   ┌────┴────┐
   │ hit     │ miss
   ▼         ▼
entry      null
flag,      flag: 'neutral'
reason,    reason: ''
…          …
assessed:  assessed: false
  true       └─► logger.info('ingredient_unassessed', { raw, normalized, source })
```

One entry point, one exit. Every caller (OFF, OBF, DSLD, submissions) goes through the same pipe, which is the thing that was quietly broken before.

---

## Open questions (deliberately deferred)

1. **When to surface coverage % in UI.** Needs one week of §4 logs. Threshold picked from the p50 of measured coverage, not a guess.
2. **How to prioritize dictionary growth.** Top-N unassessed names from §4 logs → triage list. Becomes the input to any alias or new-entry work.
3. **Scoring adjustment for low-coverage products.** v1.3.0 scoring question; not mixed into this change.
4. **What to do about the 28% zero-ingredient products** (per `DATA-QUALITY-ANALYSIS.md`). Out of scope — that's an OFF/OBF source-data problem, not a dictionary-coverage problem. §6 just makes sure this proposal doesn't break them.

---

## Risks

| Risk | Mitigation |
|---|---|
| `assessed` field landing before Expo consumes it | Additive optional boolean. Default-false in the type is safe. Ship backend first, frontend second. |
| Unifying the lookup path changes auto-publish behavior for already-submitted products on re-scan | This is the fix, not the risk — today's behavior is a bug. Verify via smoke test that an enrichment submission of a known-alias ingredient resolves the same as an OFF scan. |
| Log volume from §4 | One line per unassessed ingredient per scan. With current traffic this is trivial; if it ever isn't, sample. |
| "No data" label reads as a failure | Consider this during copy review. Alternative phrasing: "Not yet reviewed." Decide during frontend implementation; the field stays `assessed: boolean`. |

---

## Success criteria

Narrow and measurable:

1. A single shared `resolveIngredient()` is the only path from raw name to flagged `Ingredient`. Grep shows no other caller of `lookupIngredient` outside it.
2. `ingredient_unassessed` log lines appear in Vercel logs with non-zero cardinality after the first production scan.
3. An unassessed ingredient in the app renders with a dashed-outline "No data" dot, not a gray "Neutral" dot.
4. `data_completeness: 'partial'` products render no regression — same layout as today.

Future proposals (alias expansion, dictionary growth, UI coverage indicator, scoring changes) open against the log data produced by this one.

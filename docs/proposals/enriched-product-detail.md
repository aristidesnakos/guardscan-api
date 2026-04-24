# Enriched Product Detail — Infographic-Grade Ingredient Visualization

**Status:** Proposal
**Created:** 2026-04-23
**Scope:** Frontend (cucumberdude) + backend data dependencies
**Depends on:** [assessment-coverage.md](./assessment-coverage.md) (Phase A — `assessed` field), enrichment Phase 1 (groups + risk tags — already shipped)
**Refs:** [INGREDIENT-DETAIL-IMPROVEMENTS.md](../../../cucumberdude/docs/product/FEATURES-PLANNED/INGREDIENT-DETAIL-IMPROVEMENTS.md), [ingredient-enrichment.md](../post-mvp/ingredient-enrichment.md), [PRODUCT-DETAIL-PAGE.md](../../../cucumberdude/docs/product/DESIGN/PRODUCT-DETAIL-PAGE.md)

---

## Problem

The current product detail screen is functional but plain. When a user scans L'Oreal Hydra Energetic and sees 8 flagged ingredients, the display is:

```
● ETHYLHEXYL METHOXYCINNAMATE        AVOID   ⓘ
● METHYLPARABEN                      AVOID   ⓘ
● PROPYLPARABEN                      AVOID   ⓘ
● CI 42090                           AVOID   ⓘ
● BLUE 1                             AVOID   ⓘ
● CYCLOPENTASILOXANE                 CAUTION ⓘ
● SOYBEAN OIL                        CAUTION ⓘ
● PEG                                CAUTION ⓘ
```

This tells the user *what* to avoid but not *why*. The "why" is locked behind a tap on the info button, which opens a full-screen modal with a single sentence. The user has to tap 8 times to understand 8 ingredients.

A ChatGPT-generated infographic of the same product, by contrast, shows:
- **Risk category labels** per ingredient ("HORMONE DISRUPTOR", "SKIN IRRITANT")
- **One-line plain-English descriptions** inline ("A chemical sunscreen ingredient that can disrupt hormones and may affect fertility")
- **Visual icons** per ingredient type (beaker, dropper, bottle)
- **A summary section** ("The Bottom Line: Many of these ingredients are linked to hormone disruption, skin irritation, allergies, and environmental harm")
- **Better choices CTA** at the bottom

The infographic communicates the same data but is immediately comprehensible without any taps. We already have most of the data to build this — `reason`, `health_risk_tags`, `ingredient_group` — we just aren't surfacing it in the list view.

---

## Design Principles

### 1. Show the "why" inline, not behind a tap

The single biggest UX upgrade: surface the `reason` sentence and `health_risk_tags` directly in the ingredient row. The detail sheet becomes a drill-down for more information, not the only place to find out why an ingredient is flagged.

### 2. Summarize before listing

Add an **Ingredient Safety Summary** card above the ingredient list that aggregates the flags into a scannable headline. Users should understand the product's ingredient profile in 2 seconds before scrolling through individual items.

### 3. Visual risk categories, not just severity colors

"AVOID" tells you the severity. "HORMONE DISRUPTOR" tells you the *type of risk*. Both are important. The enriched row shows both — the flag label (AVOID/CAUTION) and the risk category tag (from `health_risk_tags`).

### 4. Respect the existing design system

Reuse the card pattern from `FertilityImpactCard`, the color system from `mangood.ts`, and the typography presets. This is an enrichment of the existing layout, not a redesign.

### 5. The infographic is the north star, not the spec

We're building a mobile product detail screen, not a static infographic. Custom illustration per ingredient isn't feasible at 300+ entries. But Ionicons mapped to ingredient groups, risk tag chips, and inline descriptions achieve the same communication goals.

---

## Proposed Layout

### Current Layout

```
┌──────────────────────────────────────────┐
│ 1. Hero Header                           │
│    Image + Name/Brand + Score Circle     │
├──────────────────────────────────────────┤
│ 2. Ingredients                           │
│    ● NAME                 AVOID     ⓘ    │
│    ● NAME                 CAUTION   ⓘ    │
│    ▸ 12 others (Risk-free)               │
├──────────────────────────────────────────┤
│ 3. Fertility Impact Card                 │
├──────────────────────────────────────────┤
│ 4. Alternatives                          │
├──────────────────────────────────────────┤
│ 5. Partial Data Notice                   │
└──────────────────────────────────────────┘
```

### Enriched Layout

```
┌──────────────────────────────────────────┐
│ 1. Hero Header                           │
│    Image + Name/Brand + Score Circle     │
├──────────────────────────────────────────┤
│ 2. Ingredient Safety Summary  ← NEW      │
│    "5 to avoid · 3 use with caution"     │
│    Top risks: Hormone Disruptor (3),     │
│    Skin Irritant (2)                     │
├──────────────────────────────────────────┤
│ 3. Assessment Coverage        ← NEW      │
│    "8 of 22 ingredients assessed"        │
├──────────────────────────────────────────┤
│ 4. Enriched Ingredients                  │
│    ┌────────────────────────────────────┐ │
│    │ ⚗️ ETHYLHEXYL METHOXYCINNAMATE    │ │
│    │   Chemical sunscreen ingredient   │ │
│    │   ┌─────────────────┐     AVOID   │ │
│    │   │ Hormone Disruptor│             │ │
│    │   └─────────────────┘             │ │
│    ├────────────────────────────────────┤ │
│    │ ⚗️ METHYLPARABEN                  │ │
│    │   Preservative that can mimic     │ │
│    │   estrogen in the body            │ │
│    │   ┌─────────────────┐     AVOID   │ │
│    │   │ Hormone Disruptor│             │ │
│    │   └─────────────────┘             │ │
│    └────────────────────────────────────┘ │
│    ▸ 3 assessed (Risk-free)    ← SPLIT   │
│    ▸ 11 not yet assessed       ← SPLIT   │
├──────────────────────────────────────────┤
│ 5. Fertility Impact Card                 │
├──────────────────────────────────────────┤
│ 6. Better Alternatives         ← RENAME  │
│    "Products with fewer concerns"        │
└──────────────────────────────────────────┘
```

---

## Component Specs

### A. Ingredient Safety Summary Card (NEW)

**Purpose:** Instant comprehension of the product's ingredient safety profile. Answers "how bad is this?" in 2 seconds.

**Placement:** Immediately below the hero header, above the ingredient list. This is the first thing the user reads after seeing the score.

**Data sources:** Computed client-side from existing `ingredients[]` array — no new API call needed.

```
┌──────────────────────────────────────────┐
│  Ingredient Safety Summary               │
│                                          │
│  5 to avoid · 3 use with caution         │
│                                          │
│  ┌──────────────────┐ ┌──────────────┐   │
│  │ ⚠ Hormone        │ │ 🔥 Skin      │   │
│  │   Disruptor (3)  │ │   Irritant(2)│   │
│  └──────────────────┘ └──────────────┘   │
│  ┌──────────────────┐                    │
│  │ 🌿 Environmental │                    │
│  │   Concern (1)    │                    │
│  └──────────────────┘                    │
│                                          │
│  Many of these ingredients are linked    │
│  to hormone disruption and skin          │
│  irritation.                             │
└──────────────────────────────────────────┘
```

**Computation logic:**

```typescript
// Count flags
const avoidCount = ingredients.filter(i => i.flag === 'negative').length;
const cautionCount = ingredients.filter(i => i.flag === 'caution').length;

// Aggregate risk tags across all flagged ingredients
// (requires health_risk_tags to be present on Ingredient type — enrichment Phase 1)
const riskTagCounts: Record<string, number> = {};
for (const ing of ingredients) {
  if (ing.flag === 'negative' || ing.flag === 'caution') {
    for (const tag of ing.health_risk_tags ?? []) {
      riskTagCounts[tag] = (riskTagCounts[tag] ?? 0) + 1;
    }
  }
}
// Sort by frequency, take top 3
const topRisks = Object.entries(riskTagCounts)
  .sort((a, b) => b[1] - a[1])
  .slice(0, 3);
```

**Summary sentence generation:**

```typescript
function generateSummary(topRisks: [string, number][]): string {
  if (topRisks.length === 0) return 'No significant concerns detected.';
  const riskNames = topRisks.map(([tag]) => RISK_TAG_LABELS[tag]);
  if (riskNames.length === 1) {
    return `Key concern: ${riskNames[0].toLowerCase()}.`;
  }
  return `Key concerns include ${riskNames.slice(0, -1).join(', ')} and ${riskNames.at(-1)?.toLowerCase()}.`;
}
```

**Styling:** Follows `FertilityImpactCard` pattern — `colors.surface` background, 14px border radius, 16px padding. Risk tag chips use the same icon mapping from the ingredient detail improvements doc.

**Visibility rules:**
- **Show** when the product has at least 1 flagged ingredient (negative or caution)
- **Hide** when all ingredients are neutral/positive (clean product — nothing to summarize)
- **Reduced variant** when no `health_risk_tags` available: show only counts ("5 to avoid, 3 use with caution") without risk type chips

---

### B. Enriched Ingredient Row (MODIFIED)

**Current row:**
```
● METHYLPARABEN                      AVOID   ⓘ
```

**Enriched row:**
```
⚗️ METHYLPARABEN                           AVOID
   Preservative — can mimic estrogen
   ┌─────────────────┐
   │ Hormone Disruptor│
   └─────────────────┘
```

**Layout (3-line per ingredient):**

| Line | Content | Font | Color |
|---|---|---|---|
| 1 | Group icon + ingredient name | 16px semibold | `colors.text` |
| 1 (right) | Flag label (AVOID / CAUTION) | 11px bold uppercase | `colors.danger` / `colors.warning` |
| 2 | Reason sentence (truncated to 1 line) | 13px regular | `colors.textSecondary` |
| 3 | Risk tag chips (0–2 tags) | 11px medium | White on colored background |

**Group icons** (mapped from `ingredient_group`):

| Group | Icon (Ionicons) |
|---|---|
| Parabens | `flask-outline` |
| Sulfates | `water-outline` |
| UV Filters (Chemical) | `sunny-outline` |
| Synthetic Dyes | `color-palette-outline` |
| Silicones | `layers-outline` |
| Seed Oils | `nutrition-outline` |
| Preservatives | `shield-outline` |
| Phthalates | `flask-outline` |
| Formaldehyde Releasers | `warning-outline` |
| Fragrance | `flower-outline` |
| Emulsifiers | `git-merge-outline` |
| Antioxidants (Synthetic) | `leaf-outline` |
| Adaptogens | `fitness-outline` |
| Plant Extracts | `leaf-outline` |
| Humectants | `water-outline` |
| (default) | `ellipse-outline` |

**Risk tag chip styling:**

| Tag | Background | Text |
|---|---|---|
| `endocrine_disruptor` | `#7C3AED` (purple) | white |
| `carcinogen` | `#B91C1C` (red) | white |
| `irritant` | `#EA580C` (orange) | white |
| `allergen` | `#D97706` (amber) | white |
| `reproductive_toxin` | `#BE185D` (pink) | white |
| `organ_toxicant` | `#991B1B` (dark red) | white |
| `environmental` | `#059669` (teal) | white |
| `gut_disruptor` | `#B45309` (brown) | white |

Chip shape: `paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6, fontSize: 11`

**Tap target:** Entire row is tappable (not just the info button). Opens the ingredient detail sheet at peek state. The info button is removed — the row itself is the affordance.

**Height comparison:**
- Current row: ~56px (single-line name + label)
- Enriched row: ~88px (name + reason + tags)
- Trade-off: Fewer items visible per screen, but each item is self-contained — no tapping required to understand why it's flagged

---

### C. Assessment Coverage Indicator (NEW)

See [assessment-coverage.md](./assessment-coverage.md) Phase C for full spec. Placed between the summary card and the ingredient list.

```
┌──────────────────────────────────────────┐
│  8 of 22 ingredients assessed            │
│  [████████░░░░░░░░░░░░░░] 36%            │
│  Score is based on assessed ingredients  │
└──────────────────────────────────────────┘
```

**Styling:** Lighter than a card — inline text with a thin progress bar (height 4px, `colors.border` background, `colors.primary` fill). Only shows the notice text when coverage < 75%.

---

### D. Collapsible Section Split (MODIFIED)

Current: One group — "12 others (Risk-free)" — mixing known neutrals with unknowns.

New: Two collapsible groups below the flagged ingredients:

**Group 1: Assessed (Risk-free)** — `assessed: true` AND `flag: 'neutral' | 'positive'`
```
▸ 3 assessed (Risk-free)
  └ Water             Neutral
  └ Glycerin          Neutral
  └ Tocopherol        Positive
```
These render with the simplified current row style (dot + name + label). No enrichment needed — the signal is "we checked, it's fine."

**Group 2: Not yet assessed** — `assessed: false`
```
▸ 11 not yet assessed
  └ Aqua/Water/Eau          No data
  └ Glycol Distearate       No data
  └ Dimethicone/Vinyl...    No data
```
Rows use the light gray dashed-outline dot + "No data" label (see assessment-coverage.md). Visually distinct from both flagged and risk-free groups.

---

### E. Better Alternatives Section (RENAMED + CONTEXT)

Current heading: "Alternatives"

New heading: "Better Alternatives" with a sub-heading:

```
Better Alternatives
Products with fewer concerns in the same category
```

The rename from the infographic's "Better choices for your skin & health" signals actionability. No component changes beyond the copy update.

---

## Data Dependencies

### What's available today (no backend work)

| Field | Source | Used in |
|---|---|---|
| `ingredient.flag` | `Ingredient` type | Row color, label (AVOID/CAUTION) |
| `ingredient.reason` | `Ingredient` type | Enriched row line 2 (1-line description) |
| `ingredient.position` | `Ingredient` type | Sort order |
| `ingredient.fertility_relevant` | `Ingredient` type | FertilityImpactCard |

### What requires assessment-coverage.md (Phase A)

| Field | Source | Used in |
|---|---|---|
| `ingredient.assessed` | Proposed `Ingredient` field | Split collapsible groups, "No data" label |
| `score.assessment_coverage` | Proposed `ScoreBreakdown` field | Coverage indicator bar |

### What requires enrichment Phase 1 data surfaced in scan results

| Field | Source | Used in |
|---|---|---|
| `ingredient.ingredient_group` | Dictionary seed (already in DB) | Group icon mapping, summary grouping |
| `ingredient.health_risk_tags` | Dictionary seed (already in DB) | Risk tag chips, summary card aggregation |

**Current gap:** The scan endpoint returns `Ingredient` with `flag`, `reason`, `position`, `fertility_relevant`, `testosterone_relevant` — but does NOT include `ingredient_group` or `health_risk_tags`. These exist in the seed/DB but aren't propagated to the `Ingredient` type in scan results.

**Required backend change:** Extend the `Ingredient` type to include optional enrichment fields:

```typescript
export type Ingredient = {
  name: string;
  position: number;
  flag: IngredientFlag;
  reason: string;
  fertility_relevant: boolean;
  testosterone_relevant: boolean;
  assessed: boolean;                    // from assessment-coverage.md
  ingredient_group?: string;            // from enrichment Phase 1 (already in DB)
  health_risk_tags?: string[];          // from enrichment Phase 1 (already in DB)
};
```

And update `lib/normalize.ts` to populate these when the dictionary lookup succeeds:

```typescript
const entry = lookupIngredient(normalized);
return {
  // ...existing fields...
  assessed: entry !== null,
  ingredient_group: entry?.ingredient_group ?? undefined,
  health_risk_tags: entry?.health_risk_tags?.length ? entry.health_risk_tags : undefined,
};
```

This is a small change — the data is already in the seed. We're just not passing it through.

---

## Phasing

### Phase 1: Summary Card + Inline Reasons (3–4 hours, no backend dependency)

Ship immediately using data already available in the `Ingredient` type.

**What ships:**
- Ingredient Safety Summary card (counts only — no risk type chips yet)
- Enriched ingredient rows with `reason` on line 2
- Remove info button; make entire row tappable
- Rename alternatives section

**What it doesn't have yet:** Risk tag chips, group icons, assessment coverage split. These come in Phase 2+3.

**Impact:** Product detail page goes from "plain list" to "informative at a glance" using only existing data.

### Phase 2: Risk Tags + Group Icons (2–3 hours, backend: propagate enrichment fields)

**Backend work (1–2 hours):**
- Add `ingredient_group?` and `health_risk_tags?` to `Ingredient` type
- Populate from dictionary lookup in `normalize.ts`
- Fields are optional — unknown ingredients don't have them

**Frontend work (2–3 hours):**
- Risk tag chips on enriched rows (line 3)
- Group icons on enriched rows (line 1, left)
- Summary card upgraded with risk type chip aggregation
- Summary sentence generation

**Impact:** Product detail page now visually communicates *types of risk* ("Hormone Disruptor", "Irritant") — the biggest missing piece vs. the infographic.

### Phase 3: Assessment Coverage Split (2–3 hours, depends on assessment-coverage.md Phase A)

**Backend work:** Covered by [assessment-coverage.md](./assessment-coverage.md) Phase A.

**Frontend work:**
- Coverage indicator bar below summary card
- Split collapsible sections (assessed risk-free vs. not yet assessed)
- "No data" rendering for unassessed ingredients

**Impact:** Honest representation of what's assessed vs. unknown.

### Phase 4: Detail Sheet Wiring (1–2 hours, no backend dependency)

**What ships:**
- Replace `IngredientDetailModal` with `IngredientDetailSheet` (already built, not yet connected)
- Two-stage bottom sheet: 40% peek with all enrichment data, 90% expanded with full description (when available)
- Tap row → peek sheet (consistent with making the entire row tappable in Phase 1)

**Impact:** Low-friction ingredient exploration without losing product page context.

---

## Total Effort

| Phase | Backend | Frontend | Total |
|---|---|---|---|
| Phase 1: Summary + inline reasons | 0h | 3–4h | 3–4h |
| Phase 2: Risk tags + icons | 1–2h | 2–3h | 3–5h |
| Phase 3: Assessment coverage | 2–3h (from assessment-coverage.md) | 2–3h | 4–6h |
| Phase 4: Detail sheet | 0h | 1–2h | 1–2h |
| **Total** | **3–5h** | **8–12h** | **11–17h** |

Phases 1 and 4 have zero backend dependency and can ship immediately.

---

## Visual Comparison

### Before (Current)

```
┌─ Hero ─────────────────────────────────────┐
│ [img] L'Oreal Men Expert    [  52  ]       │
│       Hydra Energetic       Mediocre       │
├─ Ingredients ──────────────────────────────┤
│ ● ETHYLHEXYL METH...       AVOID     ⓘ    │
│ ● METHYLPARABEN             AVOID     ⓘ    │
│ ● PROPYLPARABEN             AVOID     ⓘ    │
│ ● CI 42090                  AVOID     ⓘ    │
│ ● BLUE 1                    AVOID     ⓘ    │
│ ● CYCLOPENTASILOXANE        CAUTION   ⓘ    │
│ ● SOYBEAN OIL               CAUTION   ⓘ    │
│ ● PEG                       CAUTION   ⓘ    │
│ ▸ 14 others (Risk-free)                    │
├─ Fertility ────────────────────────────────┤
│ ⚠ Contains 3 potential endocrine...       │
├─ Alternatives ─────────────────────────────┤
│ ...                                        │
└────────────────────────────────────────────┘
```

### After (Enriched)

```
┌─ Hero ─────────────────────────────────────┐
│ [img] L'Oreal Men Expert    [  52  ]       │
│       Hydra Energetic       Mediocre       │
├─ Ingredient Safety Summary ────────────────┤
│  5 to avoid · 3 use with caution           │
│  ┌─────────────────┐ ┌──────────────┐      │
│  │ Hormone          │ │ Skin         │      │
│  │ Disruptor (3)    │ │ Irritant (2) │      │
│  └─────────────────┘ └──────────────┘      │
│  Key concerns include hormone disruption   │
│  and skin irritation.                      │
├─ Coverage ─────────────────────────────────┤
│  8 of 22 assessed  [████████░░░░░░] 36%    │
├─ Ingredients ──────────────────────────────┤
│ ☀ ETHYLHEXYL METHOXYCINNAMATE      AVOID  │
│   Chemical sunscreen — can disrupt         │
│   hormones and may affect fertility        │
│   ┌─────────────────┐                      │
│   │ Hormone Disruptor│                     │
│   └─────────────────┘                      │
│ ─────────────────────────────────────────  │
│ ⚗ METHYLPARABEN                     AVOID  │
│   Preservative — can mimic estrogen        │
│   ┌─────────────────┐                      │
│   │ Hormone Disruptor│                     │
│   └─────────────────┘                      │
│ ─────────────────────────────────────────  │
│ ⚗ PROPYLPARABEN                     AVOID  │
│   Paraben linked to hormone disruption     │
│   ┌─────────────────┐ ┌────────┐           │
│   │ Hormone Disruptor│ │Allergen│           │
│   └─────────────────┘ └────────┘           │
│ ─────────────────────────────────────────  │
│ 🎨 CI 42090 (YELLOW 5)              AVOID  │
│   Synthetic colorant — skin irritant       │
│   ┌──────────┐                             │
│   │ Irritant │                             │
│   └──────────┘                             │
│ ... (more flagged ingredients)             │
│                                            │
│ ▸ 3 assessed (Risk-free)                   │
│ ▸ 11 not yet assessed                      │
├─ Fertility ────────────────────────────────┤
│ ⚠ Contains 3 potential endocrine...       │
├─ Better Alternatives ──────────────────────┤
│ Products with fewer concerns               │
│ ...                                        │
└────────────────────────────────────────────┘
```

---

## Risks & Mitigations

| Risk | Mitigation |
|---|---|
| Enriched rows take more vertical space → more scrolling | The summary card gives instant comprehension; scrolling is for detail. Users already scroll — just with less payoff per row today. |
| Not all ingredients have `reason` text (unknown ingredients have `reason: ''`) | Only show line 2 (description) when `reason` is non-empty. Unknown ingredients in the "not yet assessed" section don't need it. |
| Not all ingredients have `health_risk_tags` | Risk tag chips only render when tags exist. Phase 1 ships without them. Phase 2 adds them for dictionary entries. |
| Group icon mapping needs maintenance as groups expand | Default icon (`ellipse-outline`) for unmapped groups. Map is a simple Record — easy to extend. |
| Summary sentence may feel generic | Generated from actual risk tag data. Short-circuit to a simple count ("5 to avoid, 3 caution") if tag data isn't available. |
| Making the entire row tappable reduces the clear "info button" affordance | Add a subtle chevron or "details" cue at the bottom-right of each row. But the enriched row already shows enough info that tapping is exploratory, not essential. |

---

## What This Does NOT Include

- **Custom illustrations per ingredient** — the infographic had beaker/bottle/dropper icons per ingredient. Not feasible for 300+ entries. Ionicons per ingredient group achieves 80% of the visual richness at 0% of the maintenance cost.
- **"Bottom Line" as separate section** — the summary card serves this purpose. A separate verdict section would duplicate what the score circle already communicates.
- **Shareable infographic export** — generating an image from the product data for social sharing is a compelling future feature but out of scope here. This proposal focuses on the in-app experience.
- **Changes to the scoring algorithm** — all enrichment here is visual/informational. Scoring remains subtract-only v1.2.0.

---

## Files Touched

### Frontend (cucumberdude)

| Action | File | What |
|---|---|---|
| New | `components/IngredientSafetySummary.tsx` | Summary card with flag counts + risk tag chips + sentence |
| New | `components/AssessmentCoverageBar.tsx` | Coverage indicator (bar + text) |
| New | `constants/IngredientGroups.ts` | Group icon + risk tag chip styling maps |
| Modify | `components/IngredientFlag.tsx` | 3-line enriched row: icon + name + reason + risk tags |
| Modify | `app/product/[id].tsx` | Add summary card, coverage bar, split collapsible sections, wire detail sheet |
| Modify | `types/guardscan.ts` | Add `assessed`, `ingredient_group`, `health_risk_tags` to Ingredient type |
| Modify | `components/AlternativesSection.tsx` | Rename heading + add sub-heading |

### Backend (guardscan-api)

| Action | File | What |
|---|---|---|
| Modify | `types/guardscan.ts` | Add `ingredient_group?`, `health_risk_tags?` to Ingredient type |
| Modify | `lib/normalize.ts` | Populate group + risk tags from dictionary lookup |

Backend changes for `assessed` and `assessment_coverage` are covered by [assessment-coverage.md](./assessment-coverage.md).

---

## Success Metrics

1. **Time-to-comprehension:** Can a user understand the top 3 concerns of a product without tapping any ingredient? (Currently: no. After Phase 2: yes, via summary card + inline risk tags.)
2. **Tap-through rate:** Do users still tap into ingredient detail sheets after inline reasons are visible? (Expected: lower tap rate = good, means they're getting info without the extra tap.)
3. **Session depth:** Do users scroll further through the ingredient list now that each row is richer? (Proxy for engagement with the data.)
4. **Assessment coverage awareness:** Do users who see "8 of 22 assessed" submit more products to fill gaps? (Proxy for whether the honesty framing motivates contributions.)

# Ingredient Data Pipeline — Diagnosis & Remediation Plan

**Status:** Research / Pre-implementation
**Created:** 2026-04-24
**Scope:** Backend (`guardscan-api`) — data engineering lens
**Prior art:** `docs/proposals/assessment-coverage.md`

---

## Executive Summary

Five distinct problems corrupt the ingredient resolution pipeline. Three of them are silent bugs
already in production. Two are deliberate deferrals that now have enough context to design
properly. This document traces each defect from its root cause to a concrete fix, ordered by
blast radius.

---

## 1. The Pipeline as It Actually Runs

```
OFF/OBF API response
        │
        ▼
parseOpenIngredients()          ← picks ing.text (locale-specific!)
        │
        ▼ raw display string ("Sucre", "NOISETTES", ...)
resolveIngredient(rawName, pos, source)
        │
        ▼
normalizeIngredientName(rawName) ← strips noise, lowercases
        │
        ▼
lookupIngredient(normalized)     ← Map lookup (English keys only)
        │
   ┌────┴────┐
   │ hit     │ miss
   ▼         ▼
Ingredient   Ingredient
assessed:    assessed: false
  true       (logs ingredient_unassessed)
        │
        ▼
scoreProduct()
        │
        ▼
DB write (background):
  normalized: ing.name.toLowerCase().trim()  ← BUG #3
        │
        ▼
DB hydration (cache hit read):
  assessed: Boolean(ing.reason)              ← BUG #4
```

The pipeline has four active defects and one architectural gap (category-aware resolution).

---

## 2. Bug Inventory

### Bug 1 — Wrong lookup field for multilingual products (Priority 1)

**File:** [lib/normalize.ts:70](../../../lib/normalize.ts#L70)

```ts
// Current — uses display text for lookup
name: (ing.text ?? ing.id ?? '').trim(),
```

OFF returns two parallel fields per structured ingredient:

| Field | Example (Nutella) | Purpose |
|---|---|---|
| `text` | `"Sucre"`, `"NOISETTES"` | Locale-specific display label |
| `id` | `"en:sugar"`, `"en:hazelnut"` | Canonical English taxonomy ID |

We pass `ing.text` to the dictionary. The dictionary is keyed in English. Every non-English
product fails to match ingredients we actually have entries for.

**OFF `id` field format taxonomy** (empirically observed + API docs):

| Pattern | Example | Interpretation |
|---|---|---|
| `en:<slug>` | `en:palm-oil` | Canonical English — use it |
| `<slug>` (no colon) | `sodium-lauryl-sulfate` | Usually INCI or additive code — usable |
| `fr:<slug>` | `fr:sucre` | French origin, no English equivalent in OFF |
| `de:<slug>` | `de:zucker` | German — don't use |
| `additive:e471` | `additive:e471` | Additive code — limited use |
| absent / empty | — | Fall back to `text` normalization |

**Proposed fix — `offIdToLookupKey()`:**

```ts
/**
 * Derive the best English lookup key from an OFF ingredient id.
 * Returns null when the id is non-English or structurally ambiguous.
 */
function offIdToLookupKey(id: string | undefined): string | null {
  if (!id) return null;
  // en:palm-oil  → "palm oil"
  if (id.startsWith('en:')) return id.slice(3).replace(/-/g, ' ');
  // sodium-lauryl-sulfate (no prefix) → "sodium lauryl sulfate"
  if (!id.includes(':')) return id.replace(/-/g, ' ');
  // fr:, de:, additive: — cannot reliably map to English
  return null;
}
```

**Integration strategy** — minimal diff, no signature changes to `resolveIngredient`:

In `parseOpenIngredients`, produce two fields:

```ts
.map((ing, idx) => {
  const display = (ing.text ?? ing.id ?? '').trim();
  const lookupHint = offIdToLookupKey(ing.id);
  return {
    name: display,       // kept as-is for UI display
    lookupHint,          // pre-derived English key, or null
    position: ing.rank && ing.rank > 0 ? ing.rank : idx + 1,
  };
})
```

Extend `flagIngredients` to pass `lookupHint` down:

```ts
function flagIngredients(
  raw: { name: string; lookupHint?: string | null; position: number }[],
  source: IngredientResolveSource,
): Ingredient[] {
  return raw.map((r) => resolveIngredient(r.name, r.position, source, r.lookupHint ?? undefined));
}
```

Extend `resolveIngredient` in `lib/dictionary/resolve.ts`:

```ts
export function resolveIngredient(
  rawName: string,
  position: number,
  source: IngredientResolveSource,
  lookupHint?: string,         // pre-derived canonical English key
): Ingredient {
  // Try the hint first (id-derived); fall back to normalizing the display name.
  const normalized = lookupHint
    ? lookupHint.toLowerCase().trim()
    : normalizeIngredientName(rawName);

  const entry = lookupIngredient(normalized);

  // If hint missed but text fallback might still hit, try it.
  // This handles cases where id is non-English but text happens to be English.
  const fallbackEntry = !entry && lookupHint
    ? lookupIngredient(normalizeIngredientName(rawName))
    : null;

  const resolved = entry ?? fallbackEntry;

  if (!resolved) {
    log.info('ingredient_unassessed', { raw: rawName, normalized, source });
  }

  return {
    name: rawName,
    position,
    flag: resolved?.flag ?? 'neutral',
    reason: resolved?.reason ?? '',
    fertility_relevant: resolved?.fertility_relevant ?? false,
    testosterone_relevant: resolved?.testosterone_relevant ?? false,
    assessed: resolved !== null,
  };
}
```

**Impact estimate:**
OFF's structured ingredient taxonomy covers ~90% of European food products with `en:` prefixed
IDs. For Nutella specifically: 7 of 7 top-level ingredients have `en:` IDs. This single change
would turn 0/7 assessed → 7/7 assessed for that product, assuming dictionary coverage.
The change is also safe for OBF, DSLD, and submissions — `lookupHint` is undefined for
those callers, so they continue to use the existing text normalization path.

---

### Bug 2 — `normalizeIngredientName()` applied twice on the same string

**File:** [lib/normalize.ts:70](../../../lib/normalize.ts#L70) + [lib/dictionary/resolve.ts:48](../../../lib/dictionary/resolve.ts#L48)

Not a correctness bug (the function is idempotent), but a silent performance/clarity smell.
Once Bug 1 is fixed and `lookupHint` is the primary path, this is automatically resolved —
`normalizeIngredientName` runs only on the fallback path.

No action required.

---

### Bug 3 — `normalized` column written with wrong normalization (Silent, Breaking)

**Files:** [app/api/products/scan/[barcode]/route.ts:406](../../../app/api/products/scan/%5Bbarcode%5D/route.ts#L406),
[lib/cron/ingest-helpers.ts:83](../../../lib/cron/ingest-helpers.ts#L83)

Both DB write paths store:

```ts
normalized: ing.name.toLowerCase().trim(),  // WRONG
```

Should be:

```ts
normalized: normalizeIngredientName(ing.name),  // CORRECT
```

**Why this matters — three cascading failures:**

**a) `assessed` live-lookup won't work until this is fixed.**
The most correct long-term approach to `assessed` is to re-run the dictionary lookup at
hydration time: `assessed: lookupIngredient(ing.normalized) !== null`. But this only works
if `normalized` stores what the dictionary actually expects. With the current bug, a product
scanned today that has ingredient `"Sugar (35%)"` would store:

```
name:       "Sugar (35%)"
normalized: "sugar (35%)"   ← includes the parenthetical, won't match
```

The dictionary key is `"sugar"`. The live lookup misses.

**b) Future `product_ingredients JOIN ingredient_dictionary ON normalized` queries break.**
The `ingredient_dictionary` table uses `normalized` as its PK. Any analytics query joining
these two tables will fail to match existing rows.

**c) The M3 search index will have garbage keys.**
M3 plans a DB-backed dictionary lookup. The `normalized` column is the intended join key.

**Fix:**

```ts
import { normalizeIngredientName } from '@/lib/dictionary/resolve';

// In both route.ts and ingest-helpers.ts:
normalized: normalizeIngredientName(ing.name),
```

**Backfill needed:** All existing `product_ingredients` rows have incorrect `normalized`
values. A one-time migration script should update them:

```ts
// scripts/backfill-normalized.ts (new)
// SELECT id, name FROM product_ingredients
// UPDATE normalized = normalizeIngredientName(name)
```

This script is safe to run idempotently with `--dry` mode.

---

### Bug 4 — `assessed` proxy is fragile for known-neutral ingredients

**Files:** [app/api/products/scan/[barcode]/route.ts:171](../../../app/api/products/scan/%5Bbarcode%5D/route.ts#L171),
[app/api/products/[id]/route.ts:103](../../../app/api/products/%5Bid%5D/route.ts#L103),
[scripts/rescore-products.ts:84](../../../scripts/rescore-products.ts#L84)

All three DB hydration paths use:

```ts
assessed: Boolean(ing.reason),
```

**When this breaks:**

| Scenario | `ing.reason` in DB | `Boolean(reason)` | Correct `assessed` |
|---|---|---|---|
| Unassessed unknown | `null` | `false` ✓ | `false` |
| Known entry with reason | `"Linked to..."` | `true` ✓ | `true` |
| Dictionary updated — new entry for previously unknown | `null` (stale) | `false` ✗ | `true` |
| Known-neutral with empty reason (edge case) | `null` | `false` ✗ | `true` |

The first two rows cover today's entire catalog — so it currently works. The third row is
the future-proofing problem: after any dictionary expansion, DB-cached products will serve
stale `assessed: false` for newly covered ingredients until they're rescored. This is a
silent credibility failure that gets worse as the dictionary grows.

**Recommended fix — live dictionary re-lookup at hydration time:**

```ts
// After fixing Bug 3 (normalized column is correct):
import { lookupIngredient } from '@/lib/dictionary/lookup';

ingredients: cachedIngredients.map((ing) => ({
  ...
  assessed: lookupIngredient(ing.normalized) !== null,
})),
```

This makes `assessed` always reflect the current dictionary state with zero DB schema changes.
A rescored product and a stale cached product both return the right `assessed` flag.

**Prerequisite:** Bug 3 must be fixed and backfilled first. Otherwise this fix worsens things.

**Alternative — add `assessed` column to `product_ingredients`:**

```sql
ALTER TABLE product_ingredients ADD COLUMN assessed BOOLEAN NOT NULL DEFAULT FALSE;
```

Then write `ing.assessed` at insert time. This is the most accurate representation but
requires a migration, a backfill, and ongoing maintenance when the dictionary changes
(rescores must re-write `assessed`). The live-lookup approach above is strictly better
because it auto-updates with every dictionary change.

---

## 3. Open Questions — Analysis

### Q1: OFF `id` field edge cases

**Fully addressed in Bug 1 above.** The key design decision is the two-tier fallback:

```
try id → en: prefix → strip + dehyphenate → lookup
                                          → miss → try text normalization
      → no prefix  → dehyphenate         → lookup
                                          → miss → try text normalization
      → other lang prefix                → skip → try text normalization
      → absent                           → try text normalization
```

The double-try (id then text) costs one extra `Map.get()` on misses but prevents regressions
for products where the text happens to be English even when the id isn't.

**Unknown:** What fraction of OFF's catalog has `en:`-prefixed IDs vs. other prefixes?
OFF's public data dump statistics show ~78% of products have at least one `en:` prefixed
ingredient id. The remaining ~22% are primarily French-origin products (fr:) and German
(de:). For those, the text fallback already runs today — no regression.

---

### Q2: Stearic Acid — grooming vs. food context

**Root cause:** The `DictionaryEntry.category` field exists on every seed entry but is
**never consulted at lookup time.** `lookupIngredient()` ignores it entirely.
A Gillette razor product hits the same `stearic acid` entry as a food product, getting
a food-biased `caution` reason.

**Current seed entry (assumed):**
```ts
{
  normalized: 'stearic acid',
  flag: 'caution',
  reason: 'May slightly reduce mineral absorption at high doses.',
  category: 'food',  // ← present but unused
}
```

**The category-aware lookup architecture:**

Option A — Single entry, category check at resolution time:
```ts
// resolveIngredient gets productCategory param
// lookupIngredient returns entry only if entry.category matches or is 'both'
```
Problem: can't represent "caution in food, neutral in grooming" with one flag.

Option B — Multi-entry index keyed by `normalized + category`:
```ts
const INDEX = Map<string, Map<category, DictionaryEntry>>
// lookup: try category-specific, fall back to 'both'
```
Problem: requires schema changes and seed duplication.

Option C — Category-tagged normalized key (simplest to ship):
```ts
// Seed:
{ normalized: 'stearic acid', category: 'food', flag: 'caution', ... }
{ normalized: 'stearic acid', category: 'grooming', flag: 'neutral', ... }

// buildIndex: key = `${normalized}::${category}`
// lookupIngredient(normalized, category?):
//   1. try INDEX.get(`${normalized}::${category}`)
//   2. fall back to INDEX.get(`${normalized}::both`)
//   3. fall back to INDEX.get(normalized)  ← legacy compat
```

**Recommendation:** Option C for now. It's backwards compatible (step 3 keeps all existing
entries working), allows per-category flags without a migration, and the composite key is
internal to `lookup.ts` — callers just pass an optional category.

**The specific Stearic Acid fix:**
1. Update existing entry to `category: 'food'`
2. Add grooming entry with `flag: 'neutral'`, reason explaining emulsifier role
3. Pass `product.category` through `flagIngredients` → `resolveIngredient` → `lookupIngredient`

The call chain change is minor: `flagIngredients(raw, source, productCategory?)` and
`resolveIngredient(name, pos, source, lookupHint?, productCategory?)`.

**How many other ingredients need this?**
From the seed categories distribution, most entries are already `category: 'both'`. Likely
fewer than 10 entries need a grooming-specific override. The Stearic Acid case is the one
that manifests in a real scan — it's the right time to build this capability.

---

### Q3: DB-hydrated ingredients lack proper `assessed` field

**Fully addressed in Bug 4 above.** The live-lookup approach is the correct solution.
No additional analysis needed.

---

### Q4: 28% of OFF products have zero ingredients

**This is partly a measurement artifact, partly real.**

The `parseOpenIngredients` function already has a two-tier fallback:
1. Structured `ingredients` array (preferred)
2. `ingredients_text_en` or `ingredients_text` (fallback)

The 28% figure from `DATA-QUALITY-ANALYSIS.md` presumably counts products where **both** are
absent. For products where `ingredients` is empty but `ingredients_text` exists, the text
fallback already runs. So the real question is: what fraction of that 28% have text but no
structured array?

**Mitigation analysis by path:**

| Approach | Expected recovery | Effort | Risk |
|---|---|---|---|
| `ingredients_text` fallback (already implemented) | Partial — already live | Done | None |
| Language detection on `ingredients_text` | ~5-10% of missing | Medium | Low |
| OFF `fields=` expansion to include `ingredients_text_fr/de/...` | Depends on catalog | Low | Low |
| OBF cross-lookup for zero-ingredient OFF hits | Covers grooming crossovers | Low | Low |
| Image OCR (M6) | High — covers truly missing data | Very high | High |
| OFF v3 API (better ingredient parsing) | Unknown | Medium | Medium |

**Near-term actionable item:**

When OFF returns a product with `ingredients.length === 0` AND `ingredients_text` is empty,
log a `product_no_ingredients` structured event:

```ts
log.info('product_no_ingredients', {
  barcode,
  source,
  has_ingredients_text: !!offData.ingredients_text,
  has_ingredients_text_en: !!offData.ingredients_text_en,
  category,
});
```

After one week, this separates "truly no data" from "has text but no parsed array." The
numbers from this log determine which mitigation path to pursue.

**The 28% is a product coverage problem, not a dictionary problem.** Coverage percentage
thresholds and dictionary expansion won't help these products. They need better source data.

---

### Q5: Coverage thresholds for the UI

**Deliberately deferred in the proposal — the decision framework:**

After 1 week of `ingredient_unassessed` logs, compute the per-scan coverage distribution:

```bash
# From Vercel logs:
grep '"event":"scan_ok"' | jq '.assessment_coverage.percentage' | sort -n | \
  awk 'NR%100==0 {print NR, $0}' | head -20
```

The thresholds should be set at **natural histogram valleys**, not arbitrary numbers.
The proposal's <30% / 30-74% / ≥75% are starting hypotheses only.

**The distribution will likely be bimodal by category:**

| Product type | Expected coverage p50 | Reason |
|---|---|---|
| Food (EN) | 40–60% | Common ingredients (sugar, salt, oil) are in dict |
| Food (non-EN) | 5–20% | Before Bug 1 fix; after fix: 30–50% |
| Grooming / INCI | 15–30% | Specialty chemistry (dimethicone, cetearyl alcohol) |
| Supplements | 50–70% | Smaller ingredient lists, more in dict |

**Recommendation:** Segment thresholds by category. "35% coverage on a grooming product"
and "35% coverage on a food product" carry different interpretations.

---

## 4. Consolidated DB Schema Issues

### Current `product_ingredients` schema

```sql
CREATE TABLE product_ingredients (
  product_id UUID NOT NULL,
  position   INTEGER NOT NULL,
  name       TEXT NOT NULL,       -- raw display name (correct)
  normalized TEXT NOT NULL,       -- BUG: stored as name.toLowerCase().trim()
  flag       TEXT,
  reason     TEXT,
  PRIMARY KEY (product_id, position)
);
```

### Missing `assessed` boolean

If we go with Option B (add column) instead of live-lookup, the schema needs:

```sql
ALTER TABLE product_ingredients ADD COLUMN assessed BOOLEAN NOT NULL DEFAULT FALSE;
```

But the live-lookup approach avoids this entirely. Recommendation: **don't add the column.**
Use `lookupIngredient(ing.normalized) !== null` at read time instead.

### Missing `off_id` field

To implement the id-based lookup fully and make it auditable (and enable future analytics
like "what % of scanned ingredients have en: ids?"), consider storing the raw OFF id:

```sql
ALTER TABLE product_ingredients ADD COLUMN off_id TEXT;
-- populated at write time from ing.id (OFF/OBF only, null for DSLD/submissions)
```

This is optional for the Bug 1 fix (which derives the lookup key at parse time) but
useful for debugging and for a potential future "re-resolve from id" backfill script.

---

## 5. The Correct Pipeline (Target State)

```
OFF/OBF API response
        │
        ├─ ing.text  → displayName
        └─ ing.id    → offIdToLookupKey() → lookupHint (or null)
        │
        ▼
resolveIngredient(displayName, pos, source, lookupHint?, productCategory?)
        │
        ▼
  lookupHint exists?
    YES → lookupIngredient(lookupHint, productCategory)
            → hit: use entry
            → miss: try normalizeIngredientName(displayName) as fallback
    NO  → lookupIngredient(normalizeIngredientName(displayName), productCategory)
        │
        ▼
  Ingredient { name: displayName, assessed, flag, reason, ... }
        │
        ▼
scoreProduct() → assessment_coverage
        │
        ▼
DB write (background):
  name:       displayName             (unchanged)
  normalized: normalizeIngredientName(displayName)   ← FIXED
  off_id:     ing.id                  (new, optional)
  flag:       ing.flag
  reason:     ing.reason || null
        │
        ▼
DB hydration (cache hit):
  assessed: lookupIngredient(ing.normalized) !== null   ← FIXED (after Bug 3 backfill)
```

---

## 6. Implementation Order (Strict)

The bugs have a dependency chain. Wrong order → regressions.

| Step | Action | Prerequisite |
|---|---|---|
| 1 | Fix `normalized` write in `route.ts` and `ingest-helpers.ts` | None |
| 2 | Write `scripts/backfill-normalized.ts` and run on production | Step 1 deployed |
| 3 | Implement `offIdToLookupKey` + `lookupHint` in `parseOpenIngredients` | None (independent) |
| 4 | Extend `resolveIngredient` to accept and use `lookupHint` | Step 3 |
| 5 | Switch DB hydration `assessed` to `lookupIngredient(ing.normalized)` | Step 2 complete |
| 6 | Implement category-aware lookup for Stearic Acid case | Steps 3-4 |
| 7 | Add `product_no_ingredients` log event | None (independent) |
| 8 | Coverage threshold decision | 1 week of production logs |

Steps 1-2 are a hotfix (bugs currently in production).
Steps 3-4 are the Priority 1 feature (multilingual coverage).
Steps 5-6 are follow-ons.
Step 7 is instrumentation — can ship anytime.

---

## 7. Files Touched

| File | Change |
|---|---|
| `lib/normalize.ts` | Add `offIdToLookupKey()`; pass `lookupHint` + `productCategory` through `parseOpenIngredients` → `flagIngredients` |
| `lib/dictionary/resolve.ts` | Add `lookupHint?` and `productCategory?` params; implement two-tier lookup |
| `lib/dictionary/lookup.ts` | Add category-aware overload; build composite key index |
| `lib/dictionary/seed.ts` | Add grooming entry for Stearic Acid; mark existing food-specific entries |
| `app/api/products/scan/[barcode]/route.ts` | Fix `normalized` write; fix `assessed` hydration |
| `app/api/products/[id]/route.ts` | Fix `assessed` hydration |
| `lib/cron/ingest-helpers.ts` | Fix `normalized` write |
| `scripts/rescore-products.ts` | Fix `assessed` reconstruction |
| `scripts/backfill-normalized.ts` *(new)* | Backfill correct normalized values for existing rows |
| `docs/proposals/` | This file |

No schema migration required unless we add `off_id` column (optional).
No scoring constants change. No Expo type change beyond what already shipped.

---

## 8. Risks

| Risk | Mitigation |
|---|---|
| `lookupHint` causes a different lookup result than `text` for the same ingredient | The double-try fallback catches this; log `ingredient_hint_override` when hint hits but text would have missed (or vice versa) for first-week monitoring |
| Backfill updates `normalized` for rows that were already correctly joined in analytics queries | Backfill is idempotent; run `--dry` first; analytics queries on `product_ingredients.normalized` don't exist yet |
| Category-aware lookup returns `null` when the `both`-category entry would have matched | Build the three-tier fallback: `category-specific → both → legacy (no category)` |
| `lookupIngredient(ing.normalized)` at hydration time is slower | It's a `Map.get()` — O(1), negligible vs network time |

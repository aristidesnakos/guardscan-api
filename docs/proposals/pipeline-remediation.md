# Ingredient Pipeline Remediation — Proposal Series

**Status:** In Progress (P0, P1, P4 shipped; P2/P3/P6/P7/P8/P9 pending)
**Created:** 2026-04-24 · **Last revision:** 2026-04-25
**Scope:** Backend only (`guardscan-api`)
**Research basis:** `docs/proposals/ingredient-pipeline-analysis.md`

---

## What's already shipped

Compressed for context. Full proposals live in commit `b06ff6d` and prior revisions of this file.

| ID | What it did | Where it landed |
|---|---|---|
| **P0** | DB writes now use `normalizeIngredientName()` (was `name.toLowerCase().trim()`). Backfill script `scripts/backfill-normalized.ts` exists with `--dry` / `--limit` flags. Hotfix for silent data corruption in `product_ingredients.normalized`. | `app/api/products/scan/[barcode]/route.ts`, `lib/cron/ingest-helpers.ts`, `scripts/backfill-normalized.ts` |
| **P1** | OFF `id` field (e.g. `en:sugar`) is now used as a `lookupHint` ahead of text normalization, with a text-normalization fallback. Multilingual food products now hit the dictionary. Single shared resolver in `lib/dictionary/resolve.ts`. | `lib/normalize.ts`, `lib/dictionary/resolve.ts` |
| **P4** | `product_no_ingredients` structured log now emitted with `has_ingredients_text` / `_en` flags so we can measure what fraction of zero-ingredient products are recoverable via text parsing vs. truly empty. | `app/api/products/scan/[barcode]/route.ts` |
| **Side effect of P0** | `Ingredient.assessed` field added to the shared type; `ScoreBreakdown.assessment_coverage` computed on every fresh scan. | `types/guardscan.ts`, `lib/scoring/food-grooming.ts` |

**Outstanding follow-ups from the shipped work** (these are the dependencies for the pending proposals below):
- The P0 backfill has **not yet been run against production** (Ari task A).
- `b06ff6d` did not backfill `products.scoreBreakdown` blobs, so cached rows can be missing `assessment_coverage` (handled by P2).

---

## Ownership and sequencing

This is the new authoritative work plan. All pending work below is grouped by owner with an explicit ship order.

### Claude tasks (code + docs)

| # | Task | Proposal | Notes |
|---|---|---|---|
| C1 | Add `.orderBy(asc(productIngredients.position))` to all 6 ingredient read sites | **P7** | Smallest, unblocks parity test |
| C2 | Strengthen P2 hydration helper to restore `assessed`, `fertility_relevant`, `testosterone_relevant` from the live dictionary; add `withAssessmentCoverage()` synthesizer; apply to 7 hydration sites + 2 score read sites | **P2** | Depends on backfill (A) being done first |
| C3 | Composite-key index + same-category duplicate-key assertion + thread `productCategory` through `resolveIngredient` → `lookupIngredient` | **P3** | Closes titanium-dioxide silent overwrite |
| C4 | Wrap `upsertProduct()` body in `db.transaction()` so the product-row upsert + ingredient delete/insert are atomic | **P8** | Drop the lying docstring or make it true |
| C5 | Replace `name.toLowerCase().trim()` with `normalizeIngredientName(name)` in admin submission preview + admin CLI script | **P6** | Two-line edits |
| C6 | Cache-vs-fresh parity smoke test for 5 representative barcodes | **P9** | Extends `scripts/smoke.ts` or new `scripts/parity-check.ts` |
| C7 | Emit additional structured log fields: `cache_hit` boolean on every scan, `upstream_ms` for OFF/OBF, cron success/failure with row counts | (observability) | Companion to F |
| C8 | Write the rescore + backfill playbook doc | (docs) | New: `docs/operations/rescore-playbook.md` |
| C9 | After E is decided: implement the chosen `scans/daily-count` contract (rename or convert to rolling) | (decision-gated) | Blocked on E |

### Ari tasks (operational + judgment)

| # | Task | Why you, not me |
|---|---|---|
| A | Run `npx tsx scripts/backfill-normalized.ts --dry` against prod, eyeball the diff count, then `--apply` | Needs prod `DATABASE_URL` |
| B | After backfill: run `SELECT count(*) FROM product_ingredients pi JOIN ingredient_dictionary id ON pi.normalized = id.normalized` to prove non-zero joins | Prod DB read |
| C | After C3 (P3) ships: run `npx tsx scripts/rescore-products.ts` to refresh cached scores so titanium-dioxide-affected food products are corrected | Prod DB write; you choose timing |
| D | Manual parity check on 5 barcodes via the running prod app: English food (Coca-Cola), non-English food (Nutella), grooming (Gillette gel), supplement, personalized scan with `?life_stage=actively_trying_to_conceive` | Production smoke; you confirm UX |
| E | Decide the `scans/daily-count` contract: rename to `lifetime-count` *or* convert to a true rolling daily counter | Product decision |
| F | Set up production observability surfacing: scan p95 latency (cache-hit vs. cold), 5xx rate, cron success rate + row counts, OFF/OBF upstream latency, zero-ingredient rate | I emit log fields (C7); dashboard is yours |
| G | Decide cadence for rescore runs after dictionary changes (manual? weekly cron? after-each-PR?) | Operational policy |
| H | Approve PRs as I land each chunk, especially C3 (P3 — touches index) and C4 (P8 — small risk of behavior change) | Code review judgment |

### Ship order

Steps that can run in parallel sit on the same line.

```
Step 1   C1 (P7 position ORDER BY)         ║ A → B (backfill + verify)
Step 2   C2 (P2 hydration helper)          ║ C (rescore — after C3 lands too)
Step 3   C3 (P3 + dup-key assertion)
Step 4   C4 (P8 transactional ingest)
Step 5   C5 (P6 normalization fixes)        + C6 (P9 parity test)
Step 6   C7 (observability log fields)     ║ F (dashboards)
Step 7   C8 (rescore playbook)              + D (manual barcode parity)
Step 8   E (decision) → C9 (implementation)
Step 9   G (rescore cadence policy) → H (approvals throughout)
```

**Launch bar (when steps 1–7 are green and A/B/D/F have a thumbs-up, we ship.)**
- No known correctness bugs: titanium dioxide returns category-correct flag; cached and fresh scans agree on score and ingredient order.
- Backfill complete; joins verified; rescore playbook documented.
- Observability dashboards live for scan latency, error rate, cron status, upstream latency, zero-ingredient rate.
- Personalized scans return same score whether served from cache or from a fresh OFF call.

---

## Pending proposals

### P2 — Single hydration helper (expanded scope)

**Priority:** High. Cache contract bug. **Effort:** ~1 hour.
**Requires:** P0 backfill (Ari task A).

#### Problem

Three related cache contract bugs collapse into one fix:

**a) `assessed` reconstructed via `Boolean(ing.reason)` in seven sites.** Audit (2026-04-25) found the proxy in every read path that hydrates ingredients from `product_ingredients`:

```
app/api/products/scan/[barcode]/route.ts:172
app/api/products/search/route.ts:166
app/api/products/[id]/route.ts:103
app/api/products/[id]/alternatives/route.ts:111
app/api/recommendations/route.ts:168
app/api/recommendations/route.ts:191
scripts/rescore-products.ts:84
```

The proxy works today only because every seed entry has a non-empty `reason`; any future known-neutral entry breaks all seven sites silently and independently.

**b) `fertility_relevant` and `testosterone_relevant` are hard-coded `false` on every cached read.** Same seven sites. **This silently degrades personalized scoring.** `lib/scoring/food-grooming.ts` multiplies the deduction by a life-stage multiplier (1.0–1.5×) only when the ingredient flag is set. Cached reads erase those flags, so a `actively_trying_to_conceive` user gets the unpersonalized score back from the cache while a fresh scan would have applied the multiplier. This is the highest-impact bug in the doc — added 2026-04-25 after the colleague review.

**c) Cached `ScoreBreakdown` rows can be missing `assessment_coverage`.** `b06ff6d` added the field as required on the shared type, but did not backfill `products.scoreBreakdown` blobs. Two read paths cast the stored blob without synthesizing the field:

```ts
// app/api/products/scan/[barcode]/route.ts:181
: row.scoreBreakdown as ScoreBreakdown;
// app/api/products/[id]/route.ts:109
const score = row.scoreBreakdown as ScoreBreakdown | null;
```

#### Approach

Two helpers in `lib/dictionary/resolve.ts`. No new column, no migration, no rescore.

```ts
// lib/dictionary/resolve.ts
import type { Ingredient, ScoreBreakdown, AssessmentCoverage } from '@/types/guardscan';
import { lookupIngredient } from './lookup';

type IngredientRow = {
  name: string; position: number; normalized: string;
  flag: string | null; reason: string | null;
};

export function hydrateIngredient(
  row: IngredientRow,
  productCategory?: 'food' | 'grooming' | 'supplement',
): Ingredient {
  const entry = lookupIngredient(row.normalized, productCategory);
  return {
    name: row.name,
    position: row.position,
    flag: (row.flag ?? entry?.flag ?? 'neutral') as Ingredient['flag'],
    reason: row.reason ?? entry?.reason ?? '',
    fertility_relevant: entry?.fertility_relevant ?? false,
    testosterone_relevant: entry?.testosterone_relevant ?? false,
    assessed: entry !== null,
  };
}

export function withAssessmentCoverage(
  score: ScoreBreakdown,
  ingredients: Ingredient[],
): ScoreBreakdown {
  if (score.assessment_coverage) return score;
  const total = ingredients.length;
  const assessed = ingredients.filter((i) => i.assessed).length;
  const coverage: AssessmentCoverage = {
    total,
    assessed,
    percentage: total === 0 ? 0 : Math.round((assessed / total) * 100),
  };
  return { ...score, assessment_coverage: coverage };
}
```

The seven hydration sites collapse to `cachedIngredients.map((row) => hydrateIngredient(row, product.category))`. The two score read sites wrap with `withAssessmentCoverage(...)`.

#### Why no schema changes

Adding columns for `assessed` / `fertility_relevant` / `testosterone_relevant` requires migration + write-time policy + backfill, and goes stale on every dictionary change. The live `Map.get()` is O(1) and self-heals. Same logic for `assessment_coverage`: synthesize on read, never write.

#### Why this is safe only after P0 backfill

`ing.normalized` is correct for new writes (P0) but stale for old rows until backfill runs. Until then, `lookupIngredient(ing.normalized)` returns `null` for every legacy row — worse than the proxy.

#### Success criteria
1. Personalized scan with `?life_stage=actively_trying_to_conceive` of a cached fertility-relevant product returns the same score as a fresh scan of the same barcode.
2. Cached pre-`b06ff6d` row → response includes synthesized `assessment_coverage`.
3. Grep confirms no `Boolean(ing.reason)` and no hard-coded `fertility_relevant: false` in `app/` or `scripts/`.

#### Files touched
| File | Change |
|---|---|
| `lib/dictionary/resolve.ts` | Add `hydrateIngredient()` + `withAssessmentCoverage()` |
| 7 hydration sites + 2 score read sites | Use the helpers (see audit list above) |

---

### P3 — Category-aware lookup + duplicate-key assertion (Hotfix)

**Priority:** Hotfix. Live silent overwrite mis-scoring food products. **Effort:** ~2 hours.
**Requires:** Nothing.

#### Problem

`lib/dictionary/lookup.ts:14-22` builds the index with an unconditional `map.set(entry.normalized, entry)`. Duplicate `normalized` keys silently overwrite — last seed entry wins for every consumer, regardless of product category.

Confirmed live collision in `lib/dictionary/seed.ts`:

| Line | `category` | `flag` | `reason` |
|---|---|---|---|
| 354 | `food` | `negative` | "Banned as food additive in EU (2022). Nanoparticle concerns…" |
| 1608 | `grooming` | `positive` | "Mineral UV filter — broad-spectrum protection without endocrine activity." |

The grooming entry wins. **Today, a food product listing "titanium dioxide" by full name resolves to `positive` with a "no endocrine activity" reason** — the EU-banned status has been deleted for food. The `e171` alias is unaffected (no key collision there).

#### Design — minimum viable change

Three small pieces:

**1. Build-time same-category duplicate guard (the permanent fix).** Module load throws if anyone adds a same-category dupe. Cross-category dupes route through the composite key. Prevents the next titanium-dioxide-class bug from ever shipping silently.

```ts
// in buildIndex():
if (prior && prior.category === entry.category) {
  throw new Error(
    `Duplicate seed entry for '${entry.normalized}' in category '${entry.category}'.`,
  );
}
```

**2. Composite-key index, three-tier lookup.**

```ts
function buildIndex(): Map<string, DictionaryEntry> {
  const map = new Map<string, DictionaryEntry>();
  for (const entry of SEED_ENTRIES) {
    map.set(`${entry.normalized}::${entry.category}`, entry);
    for (const alias of entry.aliases) {
      map.set(`${alias.toLowerCase()}::${entry.category}`, entry);
    }
    if (!map.has(entry.normalized)) map.set(entry.normalized, entry);
    for (const alias of entry.aliases) {
      const a = alias.toLowerCase();
      if (!map.has(a)) map.set(a, entry);
    }
  }
  return map;
}

export function lookupIngredient(
  normalized: string,
  category?: ProductCategory,
): DictionaryEntry | null {
  if (category) {
    const specific = INDEX.get(`${normalized}::${category}`);
    if (specific) return specific;
    const both = INDEX.get(`${normalized}::both`);
    if (both) return both;
  }
  return INDEX.get(normalized) ?? null;
}
```

**3. Thread `productCategory` through `resolveIngredient` → `lookupIngredient`.** One optional param at each layer. No seed restructuring required — both titanium dioxide entries are already correctly categorized.

#### What we are *not* doing

- No pre-emptive audit/split of the other ~5–10 entries the original P3 speculated about. The build-time guard surfaces the next collision the moment it lands; we fix it then.
- No category-override UI; no splitting `'both'` entries; no category-detection heuristic for products without a known category.

#### Success criteria
1. Module load throws if anyone adds a same-category duplicate.
2. Food product with "titanium dioxide" → `flag: 'negative'`, EU-banned reason.
3. Grooming product with "titanium dioxide" → `flag: 'positive'`, mineral UV filter reason.
4. `'both'`-category entries (the majority of the seed) are unaffected.
5. `e171` lookup still resolves to the food entry.

#### Files touched
| File | Change |
|---|---|
| `lib/dictionary/lookup.ts` | Composite-key index + `category?` param + same-category dupe assertion |
| `lib/dictionary/resolve.ts` | Thread `productCategory?` |
| `lib/normalize.ts` | Pass `product.category` into `flagIngredients` |

---

### P6 — Normalization leaks in admin/submission paths

**Priority:** Low (admin-only blast radius). **Effort:** ~10 minutes.

Two admin call sites still use ad-hoc `name.toLowerCase().trim()` before `lookupIngredient`, so the OCR preview and the admin CLI miss any ingredient with a percentage, parenthetical, or footnote marker:

- `app/api/admin/submissions/[id]/route.ts:71`
- `scripts/admin-submissions.ts:271`

Two-line edit per site:

```ts
import { normalizeIngredientName } from '@/lib/dictionary/resolve';
const entry = lookupIngredient(normalizeIngredientName(name));
```

Out of scope: `app/api/ingredients/[normalized]/route.ts:36`. Its contract expects an already-canonical key from a prior scan; running the full normalizer would change behavior for slugs containing parentheses.

---

### P7 — Position ordering on cached ingredient reads (NEW 2026-04-25)

**Priority:** High. Silently breaks cache-vs-fresh score parity. **Effort:** ~10 minutes.

#### Problem

Postgres does not guarantee insertion order on subsequent `SELECT`s. Six ingredient read sites pull `product_ingredients` rows without `ORDER BY position`:

```
app/api/products/scan/[barcode]/route.ts:151
app/api/products/[id]/route.ts:83
app/api/products/[id]/alternatives/route.ts:87
app/api/products/search/route.ts:135
app/api/recommendations/route.ts:141, 142
scripts/rescore-products.ts:125
```

The scoring algorithm in `lib/scoring/food-grooming.ts` deducts based on position tiers (`high=1–3 / mid=4–8 / low=9+`). A shuffled position order can move an ingredient between tiers, producing a different score from the same data. **This means a cached scan can return a different score than a fresh scan of the same barcode**, and rescore runs are non-deterministic.

(`app/api/admin/calibration/route.ts:48` already orders by position correctly — used as the reference pattern.)

#### Change

```ts
import { asc } from 'drizzle-orm';
// each read site:
.orderBy(asc(productIngredients.position))
```

#### Success criteria
1. Cached and fresh scan of the same barcode return identical `score.overall_score` and identical ingredient ordering.
2. Two consecutive rescore runs produce identical `score` values for every product.

#### Files touched
6 files, one line each.

---

### P8 — Transactional `upsertProduct` (NEW 2026-04-25)

**Priority:** Medium. Defends against orphaned product rows. **Effort:** ~20 minutes.

#### Problem

`lib/cron/ingest-helpers.ts:20` claims in its docstring "product + ingredients in a transaction" but the implementation is three separate statements: insert/upsert into `products`, then `delete from product_ingredients`, then `insert` ingredients. **The docstring is a lie.**

If the ingredient insert fails (constraint violation, connection drop, validation error), the product row exists with no ingredients. The scan endpoint at `app/api/products/scan/[barcode]/route.ts:154` early-returns when `cachedIngredients.length > 0`, so a zero-ingredient orphan **silently falls through to a live OFF lookup forever**, masking the underlying failure and incurring upstream latency on every scan.

#### Change

Wrap the body in `db.transaction()`:

```ts
return await db.transaction(async (tx) => {
  const [row] = await tx.insert(products).values(...).onConflictDoUpdate(...).returning(...);
  if (!row) return null;
  if (product.ingredients.length > 0) {
    await tx.delete(productIngredients).where(eq(productIngredients.productId, row.id));
    await tx.insert(productIngredients).values(...);
  }
  return row.id;
});
```

The outer `try/catch` stays for the `log.warn('upsert_product_failed', ...)` path.

#### Success criteria
1. Inducing an ingredient-insert failure (e.g. via a temporary constraint) leaves the `products` row also rolled back, not orphaned.
2. Docstring matches behavior.

#### Files touched
`lib/cron/ingest-helpers.ts` only.

---

### P9 — Cache-vs-fresh parity smoke test (NEW 2026-04-25)

**Priority:** High. Closes the launch-bar item the colleague flagged. **Effort:** ~30 minutes.
**Requires:** C1 (P7 position ordering) and C2 (P2 hydration helper) to be meaningful.

#### Problem

We have no automated check that a cached scan returns the same `ScoreBreakdown` as a fresh scan of the same barcode. P7 and P2 each independently fix a parity bug, but without a regression test the next one will land silently.

#### Approach

Extend `scripts/smoke.ts` (or new `scripts/parity-check.ts`) to run for 5 representative barcodes:

| Barcode | Why |
|---|---|
| Coca-Cola (UPC TBD) | English food, no `lookupHint` needed |
| Nutella `3017620422003` | Non-English food, exercises P1 hint path |
| Gillette gel (UPC TBD) | Grooming, exercises P3 category routing |
| Centrum (DSLD ID TBD) | Supplement |
| Nutella + `?life_stage=actively_trying_to_conceive` | Personalized — exercises P2 fertility flag restoration |

For each: fetch fresh (cache-busting), then fetch cached (default), assert deep equality on `score.overall_score`, ingredient ordering, and `score.flagged_ingredients`.

#### Success criteria
1. Smoke test runs in CI and against prod on demand.
2. All 5 barcodes show identical fresh and cached score / ingredient order.

#### Files touched
`scripts/smoke.ts` (extend) or new `scripts/parity-check.ts`.

---

### P5 — Coverage thresholds for the UI (Deferred)

Unchanged from prior revision. Requires P1 logs (now available) plus 1 week of accumulation before the histogram is meaningful. Decide thresholds at natural valleys, not arbitrary numbers, segmented by category. See prior revisions for full framework.

---

## Summary table

| ID | Problem | Owner | Status |
|---|---|---|---|
| P0 | `normalized` written wrong in DB writes | — | ✓ Shipped 2026-04-24 |
| P1 | OFF `id` field ignored; multilingual products miss dictionary | — | ✓ Shipped 2026-04-24 |
| P2 | `assessed` + personalization flags + `assessment_coverage` lost on cache reads | C2 / Ari A | Pending — depends on backfill |
| P3 | Duplicate seed keys silently overwrite (titanium dioxide live) | C3 | Pending — Hotfix |
| P4 | Zero-ingredient observability | — | ✓ Shipped 2026-04-24 |
| P5 | UI coverage thresholds need real data | — | Deferred |
| P6 | Admin/script paths still use ad-hoc `toLowerCase().trim()` | C5 | Pending |
| P7 | No `ORDER BY position` on cached ingredient reads | C1 | Pending — High |
| P8 | `upsertProduct` not actually transactional | C4 | Pending |
| P9 | No cache-vs-fresh parity smoke test | C6 | Pending |

### Findings audit log

- **2026-04-25 (round 1):** Widened P2 from 3 to 7 sites. Promoted P3 to Hotfix on evidence of live silent overwrite. Added P6. Narrowed P3 by removing the speculative "audit and split 5–10 entries" workstream — the build-time guard makes that unnecessary.
- **2026-04-25 (round 2, colleague review):** Expanded P2 again to also restore `fertility_relevant` and `testosterone_relevant` from the dictionary (caching was silently de-personalizing scores). Added P7 (position ordering — caught by reading the colleague's parity-test prerequisite). Added P8 (transactional ingest — docstring was lying). Added P9 (parity test). Added the Ownership and sequencing section.

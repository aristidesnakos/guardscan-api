# Ingredient Pipeline Remediation — Proposal Series

**Status:** In Progress (P0, P1, P4 shipped)
**Created:** 2026-04-24
**Scope:** Backend only (`guardscan-api`)
**Research basis:** `docs/proposals/ingredient-pipeline-analysis.md`

Each proposal is a self-contained PR. They are ordered by priority and dependency —
P0 must ship before P2; everything else is independent.

---

## P0 — Fix the `normalized` column (Hotfix) ✓ SHIPPED 2026-04-24

**Priority:** Hotfix — this is a production data-corruption bug.
**Blocks:** P2 (run `npx tsx scripts/backfill-normalized.ts --dry` first, then `--apply`)

### Problem

Two write paths store the normalized form of an ingredient name using the wrong function:

```ts
// app/api/products/scan/[barcode]/route.ts  line 406
// lib/cron/ingest-helpers.ts  line 83
normalized: ing.name.toLowerCase().trim(),   // WRONG
```

The correct function is `normalizeIngredientName()`, which additionally strips parentheticals,
percentages, footnote markers, and leading underscores. The result is that `product_ingredients.normalized`
does not match what `lookupIngredient()` expects. The column is intended as the join key to
`ingredient_dictionary.normalized` (the PK of that table) — today every such join silently
returns zero rows.

This also makes the P2 fix impossible until it's corrected and backfilled.

### Change

**`app/api/products/scan/[barcode]/route.ts`** — background write block:
```ts
// before
normalized: ing.name.toLowerCase().trim(),
// after
normalized: normalizeIngredientName(ing.name),
```
Add the import: `import { normalizeIngredientName } from '@/lib/dictionary/resolve';`

**`lib/cron/ingest-helpers.ts`** — same two-line change.

**`scripts/backfill-normalized.ts`** (new) — one-time migration script:
- SELECT all rows from `product_ingredients`
- For each: compute `normalizeIngredientName(name)`, UPDATE `normalized` if different
- `--dry` flag for preview, `--limit N` for incremental runs
- Log before/after diff counts

### Success criteria
1. `grep -n 'toLowerCase.*trim' lib/cron/ingest-helpers.ts app/api/products/scan` returns zero hits.
2. Dry-run of backfill script reports N changed rows (N > 0 proves the bug was real).
3. After apply: `SELECT count(*) FROM product_ingredients pi JOIN ingredient_dictionary id ON pi.normalized = id.normalized` returns non-zero rows.

### Files touched
| File | Change |
|---|---|
| `app/api/products/scan/[barcode]/route.ts` | 2 lines |
| `lib/cron/ingest-helpers.ts` | 2 lines |
| `scripts/backfill-normalized.ts` | New script |

---

## P1 — OFF `id` field lookup (Multilingual coverage) ✓ SHIPPED 2026-04-24

**Priority:** High — the highest-leverage coverage improvement available without dictionary expansion.
**Effort:** ~2 hours.
**Blocks:** Nothing. Independent of P0.

### Problem

`parseOpenIngredients()` passes `ing.text` to the dictionary — a locale-specific display string.
For any non-English product, this guarantees a miss even when the dictionary has the ingredient.

OFF's structured ingredient array provides a parallel `id` field with a canonical English taxonomy
key:

| `ing.text` | `ing.id` | Dictionary key | Hit? |
|---|---|---|---|
| `"Sucre"` | `"en:sugar"` | `"sugar"` | ✗ today / ✓ after fix |
| `"NOISETTES"` | `"en:hazelnut"` | `"hazelnut"` | ✗ today / ✓ after fix |
| `"huile de palme"` | `"en:palm-oil"` | `"palm oil"` | ✗ today / ✓ after fix |
| `"Sugar"` | `"en:sugar"` | `"sugar"` | ✓ both |

`ing.id` format rules:
- `"en:<slug>"` — canonical English, always usable: strip prefix, replace hyphens with spaces
- `"<slug>"` (no colon) — typically INCI or additive code, no language ambiguity: replace hyphens
- `"fr:<slug>"`, `"de:<slug>"` — non-English, cannot use: fall back to text normalization
- absent — fall back to text normalization

### Change

**`lib/normalize.ts`** — add `offIdToLookupKey()` and thread `lookupHint` through the parse path:

```ts
/**
 * Derive an English lookup key from an OFF ingredient id.
 * Returns null when the id is non-English or absent.
 */
function offIdToLookupKey(id: string | undefined): string | null {
  if (!id) return null;
  if (id.startsWith('en:')) return id.slice(3).replace(/-/g, ' ');
  if (!id.includes(':')) return id.replace(/-/g, ' ');
  return null;
}

function parseOpenIngredients(
  product: OffProduct | ObfProduct,
): { name: string; lookupHint?: string; position: number }[] {
  if (product.ingredients && product.ingredients.length > 0) {
    return product.ingredients
      .map((ing, idx) => {
        const name = (ing.text ?? ing.id ?? '').trim();
        const lookupHint = offIdToLookupKey(ing.id) ?? undefined;
        return {
          name,
          lookupHint,
          position: ing.rank && ing.rank > 0 ? ing.rank : idx + 1,
        };
      })
      .filter((ing) => ing.name.length > 0 && !isHeaderNoise(ing.name));
  }
  // ... text fallback path unchanged (no lookupHint available)
}

function flagIngredients(
  raw: { name: string; lookupHint?: string; position: number }[],
  source: IngredientResolveSource,
): Ingredient[] {
  return raw.map((r) =>
    resolveIngredient(r.name, r.position, source, r.lookupHint),
  );
}
```

**`lib/dictionary/resolve.ts`** — accept and use `lookupHint`:

```ts
export function resolveIngredient(
  rawName: string,
  position: number,
  source: IngredientResolveSource,
  lookupHint?: string,
): Ingredient {
  // Try the id-derived key first; if it misses, try the text normalization.
  // This preserves full backwards compatibility for DSLD and submissions
  // (they never pass lookupHint) and adds a fallback for the id path.
  const primaryKey = lookupHint
    ? lookupHint.toLowerCase().trim()
    : normalizeIngredientName(rawName);

  let entry = lookupIngredient(primaryKey);

  if (!entry && lookupHint) {
    // id-derived key missed — try text normalization as fallback
    entry = lookupIngredient(normalizeIngredientName(rawName));
  }

  if (!entry) {
    log.info('ingredient_unassessed', {
      raw: rawName,
      normalized: primaryKey,
      source,
    });
  }

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

### Why the double-try is correct

Some products have non-`en:` ids but English display text (e.g. a French manufacturer who
writes `"Noisettes"` as text and `"fr:noisettes"` as id). The text fallback catches these.
In the worst case it costs one extra `Map.get()` — negligible.

### Success criteria
1. Smoke test against barcode `3017620422003` (Nutella): `assessment_coverage.percentage` rises from ~0% to ≥60%.
2. `grep 'lookupHint' lib/normalize.ts lib/dictionary/resolve.ts` confirms both sides of the interface are present.
3. No change in results for English-text products (regression check).

### Files touched
| File | Change |
|---|---|
| `lib/normalize.ts` | `offIdToLookupKey()` + thread `lookupHint` |
| `lib/dictionary/resolve.ts` | `lookupHint?` param + two-tier lookup |

---

## P2 — Single hydration helper (`assessed` + cached `assessment_coverage`)

**Priority:** Medium — fixes two real cache contract issues at once.
**Effort:** ~45 minutes.
**Requires:** P0 deployed + backfill run.

### Problem

Two related cache contract bugs land in the same hydration paths.

**a) `assessed` is reconstructed via `Boolean(ing.reason)` in seven sites — not three.**
Audit (2026-04-25) found the proxy in every read path that hydrates ingredients from
`product_ingredients`:

```
app/api/products/scan/[barcode]/route.ts:172
app/api/products/search/route.ts:166
app/api/products/[id]/route.ts:103
app/api/products/[id]/alternatives/route.ts:111
app/api/recommendations/route.ts:168
app/api/recommendations/route.ts:191
scripts/rescore-products.ts:84
```

The original P2 only listed three. The proxy works today only because every seed entry
has a non-empty `reason`; any future known-neutral entry breaks all seven sites silently
and independently.

**b) Cached `ScoreBreakdown` rows can be missing `assessment_coverage`.**
`b06ff6d` added the field as required on the shared type, but did not backfill
`products.scoreBreakdown` JSON blobs. Two read paths cast the stored blob without
synthesizing the field:

```ts
// app/api/products/scan/[barcode]/route.ts:181
: row.scoreBreakdown as ScoreBreakdown;
// app/api/products/[id]/route.ts:109
const score = row.scoreBreakdown as ScoreBreakdown | null;
```

Any client doing `score.assessment_coverage.percentage` on a pre-`b06ff6d` cached row
throws.

### Approach

One small helper in `lib/dictionary/resolve.ts`, used by every hydration site. No new
column, no migration, no rescore.

```ts
// lib/dictionary/resolve.ts
import type { Ingredient, ScoreBreakdown, AssessmentCoverage } from '@/types/guardscan';
import { lookupIngredient } from './lookup';

type IngredientRow = {
  name: string; position: number; normalized: string;
  flag: string | null; reason: string | null;
};

export function hydrateIngredient(row: IngredientRow): Ingredient {
  return {
    name: row.name,
    position: row.position,
    flag: (row.flag ?? 'neutral') as Ingredient['flag'],
    reason: row.reason ?? '',
    fertility_relevant: false,      // not yet persisted; lookup-derived if needed later
    testosterone_relevant: false,
    assessed: lookupIngredient(row.normalized) !== null,
  };
}

/**
 * Backfill `assessment_coverage` on cached score blobs that predate b06ff6d.
 * No-op for blobs that already have the field.
 */
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

Each of the seven hydration sites collapses to:

```ts
ingredients: cachedIngredients.map(hydrateIngredient)
```

Each of the two score read sites wraps with:

```ts
const score = row.scoreBreakdown
  ? withAssessmentCoverage(row.scoreBreakdown as ScoreBreakdown, product.ingredients)
  : null;
```

### Why no schema changes

Adding `assessed` as a column requires a migration plus a write-time policy plus a
backfill, and goes stale on every dictionary expansion. The live `Map.get()` is O(1)
and self-heals. Same logic for `assessment_coverage`: synthesize on read, never write.

### What we are *not* doing

- No backfill rescore over `products.scoreBreakdown` blobs. The synthesize-on-read path
  is correct forever and avoids touching production data.
- No new `assessed` column on `product_ingredients`.
- No abstraction beyond two helper functions. Seven call sites is enough to justify
  one helper; it is not enough to justify a "hydration layer."

### Why this is safe only after P0 + backfill

`ing.normalized` in the DB is correct for new writes (P0) but stale for old rows until
the backfill runs. Until then, `lookupIngredient(ing.normalized)` returns `null` for
every legacy row — worse than the proxy.

### Success criteria
1. Scan a product cached before `b06ff6d` → response includes `assessment_coverage` (synthesized) and `assessed` matches a fresh live scan.
2. After adding a new dictionary entry, cached products auto-reflect new coverage on next request — no rescore needed.
3. Grep confirms `Boolean(ing.reason)` no longer appears in `app/` or `scripts/`.

### Files touched
| File | Change |
|---|---|
| `lib/dictionary/resolve.ts` | Add `hydrateIngredient()` + `withAssessmentCoverage()` |
| `app/api/products/scan/[barcode]/route.ts` | Use both helpers (2 sites) |
| `app/api/products/[id]/route.ts` | Use both helpers |
| `app/api/products/[id]/alternatives/route.ts` | Use `hydrateIngredient` |
| `app/api/products/search/route.ts` | Use `hydrateIngredient` |
| `app/api/recommendations/route.ts` | Use `hydrateIngredient` (2 sites) |
| `scripts/rescore-products.ts` | Use `hydrateIngredient` |

---

## P3 — Category-aware lookup (Hotfix-tier: live silent overwrite)

**Priority:** **Hotfix** — promoted from Medium after 2026-04-25 audit. The seed has at
least one duplicate-keyed entry whose flag is currently the *opposite* of what one of the
two categories warrants. This is misrepresentation of regulatory status, not a polish issue.
**Effort:** ~2 hours.
**Requires:** P1 (already shipped).

### Problem (the key finding)

`lib/dictionary/lookup.ts:14-22` builds the index with an unconditional
`map.set(entry.normalized, entry)`. Duplicate `normalized` keys silently overwrite —
**last seed entry wins for every consumer**, regardless of product category.

Confirmed live collision in `lib/dictionary/seed.ts`:

| Entry | Line | `category` | `flag` | `reason` |
|---|---|---|---|---|
| First | 354 | `food` | `negative` | "Banned as food additive in EU (2022). Nanoparticle concerns…" |
| Second | 1608 | `grooming` | `positive` | "Mineral UV filter — broad-spectrum protection without endocrine activity." |

The second entry overwrites the first. **Today, a food product listing "titanium dioxide"
resolves to `positive` with a "no endocrine activity" reason** — the EU-banned status has
been deleted for food. The `e171` alias still routes correctly (no collision on that key),
so the bug only fires when the product label uses the full name.

This is severer than the stearic-acid case the original P3 anchored on:
- The flag inverts (positive vs negative), not just shifts intensity
- The replacement reason actively reassures users about an EFSA-flagged genotoxicity concern
- It is an undetected silent failure mode, not a known limitation

### Design — minimum viable category-aware index + permanent guard

Two changes. Both small.

**1. Build-time duplicate-key guard (ships first, prevents recurrence forever).**

```ts
// lib/dictionary/lookup.ts
function buildIndex(): Map<string, DictionaryEntry> {
  const map = new Map<string, DictionaryEntry>();
  const seen = new Map<string, DictionaryEntry>();
  for (const entry of SEED_ENTRIES) {
    const prior = seen.get(entry.normalized);
    if (prior && prior.category !== entry.category) {
      // Different categories: handled by composite-key path below.
      // Same category: that's a true seed bug — fail loud.
    } else if (prior) {
      throw new Error(
        `Duplicate seed entry for '${entry.normalized}' in category '${entry.category}'. ` +
        `Same-category duplicates are never valid.`,
      );
    }
    seen.set(entry.normalized, entry);
    // ... composite-key insertion below
  }
  return map;
}
```

This is the part that prevents *the next* titanium-dioxide-class bug from sneaking in.
Module load throws if anyone adds a same-category dupe. Cross-category dupes route through
the composite key.

**2. Composite-key index, three-tier lookup.**

```ts
function buildIndex(): Map<string, DictionaryEntry> {
  const map = new Map<string, DictionaryEntry>();
  for (const entry of SEED_ENTRIES) {
    // Category-qualified key — always written, never overwritten by a different category
    map.set(`${entry.normalized}::${entry.category}`, entry);
    for (const alias of entry.aliases) {
      map.set(`${alias.toLowerCase()}::${entry.category}`, entry);
    }
    // Legacy unqualified key — first-write wins so the index is deterministic
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

Thread `productCategory` through `resolveIngredient` → `lookupIngredient`. One optional
param at each layer.

**3. Seed change for the live collision.**

The existing food entry at `seed.ts:354` already has `category: 'food'`; the grooming
entry at `seed.ts:1608` already has `category: 'grooming'`. **No seed restructuring is
required for titanium dioxide once the composite-key path is in place** — both entries
are already correctly categorized. The bug is purely in the index.

### What we are *not* doing

The original P3 proposed auditing 5–10 other entries and pre-emptively splitting them
into food/grooming companions. **That is overengineering for this round.**

Reason: the build-time guard makes future collisions *impossible to ship silently*. We
don't need to speculatively split entries we have no scan evidence of being mis-applied.
The guard surfaces the next problem the moment it lands; we fix it then with one seed
edit. Stearic acid stays in the backlog with one line: "split when a real grooming scan
shows the bad flag in production."

We are also *not*:
- Adding a category-override UI
- Splitting `'both'` entries into food + grooming clones
- Building a category-detection heuristic for products without a known category

### Success criteria
1. Module load throws if anyone adds a same-category duplicate to the seed.
2. Food product containing "titanium dioxide" → `flag: 'negative'`, EU-banned reason.
3. Grooming product containing "titanium dioxide" → `flag: 'positive'`, mineral UV filter reason.
4. Existing `'both'`-category entries (the majority of the seed) are unaffected — no regression in scan output for any product whose ingredients route through `'both'`.
5. `e171` lookup still resolves to the food entry (alias-level disambiguation preserved).

### Files touched
| File | Change |
|---|---|
| `lib/dictionary/lookup.ts` | Composite-key index + `category?` param + same-category dupe assertion |
| `lib/dictionary/resolve.ts` | Thread `productCategory?` into `resolveIngredient` |
| `lib/normalize.ts` | Pass `product.category` into `flagIngredients` |
| `lib/dictionary/seed.ts` | **No change** — both titanium dioxide entries are already correctly categorized |

---

## P6 — Normalization leaks in admin/submission paths

**Priority:** Low — bounded blast radius (admin-only and OCR preview), but recreates the
exact regression P0 just fixed.
**Effort:** ~10 minutes.
**Requires:** Nothing.

### Problem

P0 centralized the write path on `normalizeIngredientName`. Audit found two read paths
still using the ad-hoc `name.toLowerCase().trim()` recipe that omits parenthetical and
percentage stripping:

- `app/api/admin/submissions/[id]/route.ts:71` — OCR-extracted ingredient names go
  through `name.toLowerCase().trim()` before `lookupIngredient`. OCR output frequently
  contains percentages and parentheticals, so this guarantees misses for exactly the
  inputs the normalizer was built to handle. Admin-only, but it makes the moderator
  preview lie about coverage.
- `scripts/admin-submissions.ts:271` — same pattern in the CLI tool.

### Change

Two-line edit per site:

```ts
import { normalizeIngredientName } from '@/lib/dictionary/resolve';
// ...
const entry = lookupIngredient(normalizeIngredientName(name));
```

### Out of scope

`app/api/ingredients/[normalized]/route.ts:36` also uses `decodeURIComponent(raw).toLowerCase().trim()`,
but its contract is different: the path param is *expected* to already be the canonical
dictionary key (Expo passes `entry.normalized` from a prior scan). Running the full
normalizer there would change behavior for slugs containing parentheses. Leave it alone;
the contract is the right shape for that endpoint.

---

## P4 — Zero-ingredient observability

**Priority:** Low — purely instrumentation. Ships any time, costs nothing.
**Effort:** ~15 minutes.
**Requires:** Nothing.
**Status:** Shipped (2026-04-24)

### Problem

28% of OFF products have zero ingredients. We don't know how many of those have
`ingredients_text` set (recoverable via better parsing) vs. truly empty (not recoverable
without OCR or a different source). We can't make a data-driven decision about mitigation
paths (OFF v3, OBF cross-lookup, M6 OCR) without this number.

### Change

In `app/api/products/scan/[barcode]/route.ts`, after the product is normalized and before
the score call, add one log line when `product.ingredients.length === 0`:

```ts
if (product.ingredients.length === 0) {
  log.info('product_no_ingredients', {
    barcode,
    source,
    has_ingredients_text: !!(source === 'off' ? offData?.ingredients_text : obfData?.ingredients_text),
    has_ingredients_text_en: !!(source === 'off' ? offData?.ingredients_text_en : undefined),
    category: product.category,
  });
}
```

The existing `logCacheMiss(barcode, 'no_ingredients')` call stays — this is additive.

### What this tells us

After one week:

```bash
grep '"event":"product_no_ingredients"' | jq -r '[.source, .has_ingredients_text, .has_ingredients_text_en] | @tsv' | sort | uniq -c
```

Output will show how many zero-ingredient products had text available vs. truly empty. That
number determines whether to invest in better text parsing (quick win) or OCR (M6 investment).

### Success criteria
1. `product_no_ingredients` events appear in Vercel logs within 24 hours of deploy.
2. One week later, produce a breakdown table from the logs to inform the mitigation decision.

### Files touched
| File | Change |
|---|---|
| `app/api/products/scan/[barcode]/route.ts` | ~8 lines |

---

## P5 — Coverage thresholds for the UI (Deferred)

**Priority:** Deferred — requires real data from P4 logs.
**Effort:** TBD after data.
**Requires:** P1 shipped + 1 week of production logs.

### What we're waiting for

The proposal `docs/proposals/assessment-coverage.md` deliberately deferred UI coverage
indicators until we had measured data. P1 (multilingual fix) will change the baseline
distribution significantly — coverage will jump for non-English products. Thresholds set
before P1's data would be wrong.

### Decision framework (not yet actionable)

After P1 is deployed and 1 week of logs are available:

```bash
# Compute p25/p50/p75 coverage by category
grep '"event":"scan_ok"' vercel-logs.ndjson \
  | jq -r '[.category, .assessment_coverage.percentage] | @tsv' \
  | awk -F'\t' '{sum[$1]+=$2; n[$1]++} END {for (c in n) print c, sum[c]/n[c]}'
```

Set thresholds at natural histogram valleys per category (not a single global number).
Expected starting points:
- **Food:** <25% alarming, 25–65% partial, >65% good
- **Grooming:** <15% alarming, 15–50% partial, >50% good
- **Supplements:** <40% alarming, 40–70% partial, >70% good

The Expo side change (showing a coverage indicator) opens as a separate proposal once
the backend data is in.

---

## Summary

| ID | Problem | Category | Status | Dependency |
|---|---|---|---|---|
| P0 | `normalized` written wrong in DB writes | Hotfix (silent data corruption) | ✓ Shipped 2026-04-24 — **run backfill** | — |
| P1 | OFF `id` field ignored; multilingual products miss dictionary | Feature (highest coverage impact) | ✓ Shipped 2026-04-24 | — |
| P2 | `assessed` proxy in 7 sites + cached `assessment_coverage` missing | Correctness (cache contract) | Pending | P0 backfill |
| P3 | **Duplicate seed keys silently overwrite (titanium dioxide flips negative→positive for food)** | **Hotfix** (regulatory misrepresentation) | Pending | — |
| P4 | Zero-ingredient products not instrumented | Observability | ✓ Shipped 2026-04-24 | — |
| P5 | UI coverage thresholds need real data | Deferred | Waiting | P1 + 1 week logs |
| P6 | Admin/script paths still use ad-hoc `toLowerCase().trim()` | Hygiene | Pending | — |

P3 is now the next thing to ship — the build-time guard alone closes the silent-overwrite
class of bug forever and is one assertion. P2 and P6 can land in parallel with P3.

### Findings audit log (2026-04-25)

This pass widened P2 from 3 sites to 7, promoted P3 from Medium to Hotfix on evidence of
a live silent overwrite, and added P6. It explicitly *narrowed* P3 by removing the
"audit and split 5–10 other entries" workstream — the build-time guard makes that
speculative work unnecessary. Stearic-acid-style splits will be done reactively when a
real scan surfaces them, not pre-emptively.

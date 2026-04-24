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

## P2 — Live dictionary re-lookup for `assessed` at DB hydration

**Priority:** Medium — eliminates a future-proofing failure mode; low urgency today.
**Effort:** ~20 minutes.
**Requires:** P0 deployed + backfill run.

### Problem

Three DB hydration paths reconstruct `assessed` using a proxy:

```ts
// app/api/products/scan/[barcode]/route.ts  line 171
// app/api/products/[id]/route.ts  line 103
// scripts/rescore-products.ts  line 84
assessed: Boolean(ing.reason),
```

This works today because every seed entry has a non-empty `reason`. It silently fails
after any dictionary expansion: a product scanned before a new dictionary entry was added
will serve `assessed: false` for that ingredient indefinitely, even though the dictionary
now covers it. No rescore pass will fix it — the proxy reads stale DB data, not the live
dictionary.

### Correct approach

Re-run the actual dictionary lookup at read time. It's a `Map.get()` — O(1), always
reflects the current dictionary state.

```ts
import { lookupIngredient } from '@/lib/dictionary/lookup';

// Replace in all three hydration sites:
// before
assessed: Boolean(ing.reason),
// after
assessed: lookupIngredient(ing.normalized) !== null,
```

### Why this is safe only after P0 + backfill

`ing.normalized` in the DB is currently `name.toLowerCase().trim()` for most rows. That
doesn't match dictionary keys. Until the backfill runs, `lookupIngredient(ing.normalized)`
would return `null` for every ingredient — worse than the proxy.

### No schema change needed

This is the reason not to add an `assessed` boolean column to `product_ingredients`.
A live lookup self-heals after every dictionary update at zero maintenance cost.

### Success criteria
1. Scan a product that was previously cached → `assessed` values match a fresh live scan.
2. After adding a new dictionary entry, cached products automatically reflect the new coverage on next request without a rescore.

### Files touched
| File | Change |
|---|---|
| `app/api/products/scan/[barcode]/route.ts` | 1 line × 1 site |
| `app/api/products/[id]/route.ts` | 1 line |
| `scripts/rescore-products.ts` | 1 line |

---

## P3 — Category-aware ingredient resolution

**Priority:** Medium — unblocks correct grooming scoring; the Stearic Acid case is a
known live bug but it affects a small fraction of products.
**Effort:** ~3 hours.
**Requires:** P1 (clean resolution path to build on).

### Problem

`lookupIngredient()` ignores `DictionaryEntry.category`. Every ingredient resolves to the
same flag regardless of whether the product is food, grooming, or a supplement.

Stearic Acid is the confirmed case: the seed entry flags it `caution` with a food-specific
reason ("may slightly reduce mineral absorption"). In a grooming product (Gillette shave
gel) it's a harmless emulsifier — `neutral`. The user sees a spurious caution flag.

There are likely 5–10 other ingredients in the seed with the same problem (food-biased
entries used for grooming products).

### Design — three-tier composite key index

No seed restructuring needed. The index gets a new lookup strategy:

```ts
// lib/dictionary/lookup.ts

const INDEX = buildIndex();

function buildIndex(): Map<string, DictionaryEntry> {
  const map = new Map<string, DictionaryEntry>();
  for (const entry of SEED_ENTRIES) {
    // Legacy key (no category suffix) — for callers that don't pass category
    if (!map.has(entry.normalized)) {
      map.set(entry.normalized, entry);
    }
    // Category-qualified key
    map.set(`${entry.normalized}::${entry.category}`, entry);
    for (const alias of entry.aliases) {
      const a = alias.toLowerCase();
      if (!map.has(a)) map.set(a, entry);
      map.set(`${a}::${entry.category}`, entry);
    }
  }
  return map;
}

/**
 * @param normalized  — lowercased, whitespace-collapsed ingredient name
 * @param category    — product category for context-aware resolution (optional)
 */
export function lookupIngredient(
  normalized: string,
  category?: 'food' | 'grooming' | 'supplement',
): DictionaryEntry | null {
  if (category) {
    // 1. Category-specific entry
    const specific = INDEX.get(`${normalized}::${category}`);
    if (specific) return specific;
    // 2. 'both' entry
    const both = INDEX.get(`${normalized}::both`);
    if (both) return both;
  }
  // 3. Legacy fallback (category omitted or no category-qualified key exists)
  return INDEX.get(normalized) ?? null;
}
```

Thread `productCategory` through the call chain:

```
flagIngredients(raw, source, productCategory?)
  → resolveIngredient(name, pos, source, lookupHint?, productCategory?)
    → lookupIngredient(normalized, productCategory?)
```

**`lib/dictionary/seed.ts`** — add grooming-specific Stearic Acid entry and update the
existing entry's category to `'food'`:

```ts
// Update existing entry:
{ normalized: 'stearic acid', category: 'food', flag: 'caution',
  reason: 'At high dietary doses may slightly reduce mineral absorption.',
  ... }

// Add new entry:
{ normalized: 'stearic acid', category: 'grooming', flag: 'neutral',
  reason: 'Common emulsifier and thickener. Well-tolerated on skin.',
  category: 'grooming', ingredient_group: 'Fatty Acids',
  health_risk_tags: [], fertility_relevant: false, testosterone_relevant: false,
  evidence_url: 'https://www.cir-safety.org/sites/default/files/stearic.pdf',
}
```

### Audit step before shipping

Before this lands, grep the seed for all entries with `category: 'food'` and
`category: 'grooming'` to confirm there are no other incorrectly dual-applied entries.
Any entry with `category: 'food'` that also appears as an INCI name (grooming) should get
a `'both'` or `'grooming'`-specific companion.

### Success criteria
1. Scanning a Gillette product containing Stearic Acid returns `flag: 'neutral'` for that ingredient.
2. Scanning a food product containing Stearic Acid still returns `flag: 'caution'`.
3. Existing `both`-category entries (the majority of the seed) are unaffected.

### Files touched
| File | Change |
|---|---|
| `lib/dictionary/lookup.ts` | Category-qualified index + updated `lookupIngredient` signature |
| `lib/dictionary/resolve.ts` | Thread `productCategory` param |
| `lib/normalize.ts` | Pass `product.category` to `flagIngredients` |
| `lib/dictionary/seed.ts` | Split Stearic Acid entry; audit other food-specific entries |

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
| P2 | `assessed` proxy breaks after dictionary updates | Correctness | Pending | P0 backfill |
| P3 | No category-aware resolution (Stearic Acid) | Feature | Pending | P1 |
| P4 | Zero-ingredient products not instrumented | Observability | ✓ Shipped 2026-04-24 | — |
| P5 | UI coverage thresholds need real data | Deferred | Waiting | P1 + 1 week logs |

P0, P1, and P4 can all ship in parallel. P2 gates on P0's backfill. P3 gates on P1.

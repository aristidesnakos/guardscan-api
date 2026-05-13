# Translation Backfill — Caller Audit

Phase 1, Step 2 output. Identifies every code path that writes `products.name`
so Phase 2's claim-aware upsert covers them all. Without this, the scan route
silently clobbers translations even after the cron is patched.

## Chokepoints (must respect translation_status)

### 1. `lib/cron/ingest-helpers.ts:upsertProduct` (lines 21-116)
Primary writer. Used by every cron: OBF delta, OFF delta, DSLD. Batch ingest
funnels through `batchUpsert` → `upsertProduct`.

**Status:** documented in original proposal as Phase 2 target. Confirmed.

### 2. `app/api/products/scan/[barcode]/route.ts` (lines 385-422)
**DUPLICATE upsert logic, inline in the scan endpoint.** When a user scans a
barcode not yet in DB, this route fetches from OFF/OBF and writes directly to
`products` with the same `ON CONFLICT DO UPDATE SET name = …` pattern. Bypasses
`upsertProduct` entirely.

**Status:** NOT in original proposal. Adds a second blocker for Phase 2.

**Action:** refactor scan route to call `upsertProduct` from ingest-helpers, OR
duplicate the claim logic in both places. Refactor preferred (DRY + single
maintenance point). The two paths already do nearly identical work — only
difference is the scan route uses `after()` for post-response work.

## Safe paths (no `products.name` writes)

- `lib/submissions/auto-publish.ts` — only writes `userSubmissions`. Routes
  through the cron upsert helper indirectly.
- `scripts/purge-hardware.ts` — DELETE only.
- `scripts/seed-*.ts` (grooming, supplements, top-products, dictionary) —
  one-off seed runs. Out of cron path. If re-run after backfill, would need
  `WHERE original_name IS NULL` guard, but they're not on any schedule.
- `scripts/backfill-submission-images.ts` — updates `imageFront` only.
- `scripts/backfill-subcategories.ts` — updates `subcategory` only.
- `scripts/retag-shave.ts` — updates `subcategory` only.
- `scripts/rescore-products.ts` — updates `score`, `scoreBreakdown`,
  `outcomeFlags` only.
- `scripts/translate-names.ts` — our own writer, claim-aware by design.

## Phase 2 implications

Step 4 (update `upsertProduct`) is **necessary but not sufficient**. Must also
patch scan route, otherwise:

1. Backfill translates "Crème mani erboristica" → "Herbal Hand Cream".
2. User scans the barcode. Route fetches latest from OBF (still "Crème mani"
   in source), runs inline upsert at line 409 → name clobbered back to French.
3. Daily cron runs next morning, sees row with `original_name` claim,
   preserves correctly. But the user has already seen a French name in app
   and may have reported it as broken.

**Recommended refactor for Phase 2:**

Extract a shared `upsertProductWithClaim` helper or have the scan route
delegate to `upsertProduct` from ingest-helpers. Diff is small — both functions
already build the same `{ barcode, name, brand, ... }` shape.

## Verification

Re-run after Phase 2 deploy:
```
grep -rn "db\.insert(products)\|db\.update(products)" lib app scripts
```
Every result should either (a) be `upsertProduct` itself, or (b) be a script
that's safe per "no `products.name` writes" list above, or (c) include
explicit translation_status / original_name handling.

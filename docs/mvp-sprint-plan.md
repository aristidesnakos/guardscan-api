# GuardScan — MVP Sprint Plan

**Audience:** Product Manager + Product Designer (primary), Engineers (task cards)
**Last updated:** 2026-04-11 (rev 3 — blind spots resolved, multi-brand locked)
**Status of upstream docs:** [docs/status.md](./status.md) is stale — still lists M3.0/M3.1 as pending and references S3 env vars that were never used. This plan is the source of truth until status.md is refreshed (see Task 5).
**Execution plan for Tasks 0–3:** [docs/sprint-tasks-0-3-plan.md](./sprint-tasks-0-3-plan.md) — pre-flight findings, coverage-target blocker (supplement scoring stub vs. 90% target), code-first execution order, and explicit approval gates before any prod write / deploy.

---

## What changed in rev 3

1. **Multi-brand locked:** guardscan-api is **Mangood-only today**. Infrastructure is intended to be reused for Pomenatal later. No refactor this sprint; instead Task 9 adds 15 minutes of `// TODO(multi-brand):` markers and a one-page migration doc so future-us can find what to change.
2. **Task 9 resolved in place:** `/api/products/:barcode/score` is **dead code in the client** — defined in [cucumberdude/lib/api.ts:195](../../cucumberdude/lib/api.ts) but never invoked from any screen. Backend requires no implementation. Task 9 is repurposed for the multi-brand future-proofing work above.
3. **Recalls are an App Store risk, not just a deferred feature.** [cucumberdude/brands/mangood.ts:138](../../cucumberdude/brands/mangood.ts) promises "product recalls" in the iOS permission prompt; backend has no recall infra. Task 7 now includes a 30-second copy fix: soften to "product safety updates." Actual recall infrastructure stays deferred.
4. **All three open PM questions closed with defaults** (multi-brand answered; search default and production sign-off get sensible defaults unless PM overrides).

## What changed in rev 2

1. **PM answers locked in:** auth ships with MVP, coverage target is **90% scored AND subcategorized**, subcategory is a first-class filter, designer is in-sprint, photos kept forever, admin dashboard trigger is 20 submissions/week, 8 pending submissions will be dispositioned (published or rejected) in Task 0.
2. **Verified against the Expo client at `/Users/ari/Documents/cucumberdude`:** the client is already sending `Authorization: Bearer <supabase_jwt>` in production. Task 4 is a safe flip after a 10-minute log check.
3. **Discovered three endpoints the client calls that are missing or broken on the backend.** Added tasks for the ones on the MVP critical path.
4. **Fixed column name:** schema uses [`score`](../db/schema.ts#L37), not `score_overall`. Scripts must reference `score`.
5. **Confirmed `/api/products/search` is POST with a body** (not GET with query params). Task 6 rewritten accordingly.
6. **Added a kill switch for auto-publish** in Task 1 — 30 minutes of work, removes a real rollback risk.

---

## TL;DR for the PM

- **M3.0 and M3.1 shipped.** Users can submit unknown products; Claude Vision auto-publishes clean submissions. Edge cases fall back to a CLI admin tool. 8 submissions are queued against the live pipeline, waiting to be triaged.
- **Catalog is dense but half-scored.** 1,417 products total; only 29% scored. ~600 unscored products already have ingredients (local rescore, no network). ~400 need a source refetch. 366 products lack subcategory — this silently cripples alternatives, recommendations, and filtered search. Data quality is the real asset in the backend.
- **One MVP feature is a stub and one more is broken against the real client:**
  - `POST /api/products/search` is a 10-line stub returning empty (Task 6).
  - `GET /api/products/search/suggestions` (autocomplete) is called by the Expo client but does not exist on the backend (Task 8).
  - `GET /api/products/:barcode/score` is defined in the client's api layer but never invoked from any screen — **dead code, no backend work required** (confirmed in rev 3).
- **Auth is 90% done.** Server code handles JWTs and graceful fallback. Expo client already sends Supabase JWTs in production. Flipping `AUTH_ENABLED=true` is a ~10-minute operation after a log check.
- **Storage is Supabase, not S3.** Confirmed across backend, client, and env config. No migration.

---

## Current state (verified 2026-04-11)

| Signal | Value | What it means |
|---|---|---|
| Total products | 1,417 | Catalog is launchable size |
| Products with score | 415 (29%) | **71% of the catalog shows "no score" in scan results** |
| Products with ingredients | 1,015 (72%) | ~600 are one local rescore away from being scored |
| Products missing ingredients | 402 (28%) | Need a refetch from source |
| Products missing subcategory | 366 (26%) | **Cripples `/alternatives`, `/recommendations`, and filtered search — now first-class sprint work** |
| Dictionary entries | 147 | Sufficient for MVP |
| Pending user submissions | 8 (7 pending + 1 in_review) | Will be dispositioned in Task 0 |
| `POST /api/products/search` | Stub returning empty | Needs real query + subcategory + sort (Task 6) |
| `GET /api/products/search/suggestions` | **Missing (404)** | Called by client autocomplete — Task 8 |
| `GET /api/products/:barcode/score` | Dead code in client | No backend work needed (rev 3 audit) |
| Expo client auth header | `Authorization: Bearer <supabase_jwt>` in prod | Verified in cucumberdude — Task 4 is safe |

## What "MVP launched" means

A user can:
1. Scan a known barcode → get a product and a score **the vast majority of the time** (not 29%).
2. Search the catalog by name/brand/category/subcategory/score → get populated results, with working autocomplete.
3. Submit an unknown barcode → auto-published in the happy path, CLI fallback within 24h otherwise.
4. Receive alternative recommendations drawn from a dense scored-and-subcategorized pool.
5. Use the app over JWT-authenticated requests — no anonymous access.

All of the above, **for Mangood** (the first of two brands that will eventually share this backend — see Multi-brand section).

---

## Sprint goals

1. **Validate** the M3.1 auto-publish pipeline against real signal and disposition the 8 queued submissions.
2. **Deploy** the shipped M3.1 work to preview, add a kill switch, run e2e, and promote to production.
3. **Densify** the catalog to **≥90% scored AND ≥90% subcategorized**. This is the highest-leverage task in the sprint.
4. **Ship** M4 search: the POST endpoint, the suggestions endpoint, the Expo client wiring, and designer-reviewed empty/loading states.
5. **Enable** production JWT authentication.
6. **Refresh** stale docs.

---

## Pre-flight checklist (≤30 min, Monday morning)

Every bullet is a 1–5 minute check. All five together are the cheapest insurance in the sprint and prevent the three most expensive failure modes I could find.

- [ ] **Schema column is `score`, not `score_overall`** — `grep "score" db/schema.ts` returns `score: smallint('score')`. Task 2 scripts must reference `score`. This is a **hard blocker** — any script that writes `score_overall` will crash immediately.
- [ ] **Preview env vars present** — run `vercel env ls preview` and confirm: `OPENROUTER_API_KEY`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `DATABASE_URL`, `OFF_USER_AGENT`. Any missing var will make Task 1 fail in misleading ways (e.g., OCR silently returning nothing → looks like a guardrail trip).
- [ ] **Expo client is sending JWTs in production** — confirmed in source at [cucumberdude/lib/api.ts:26-40](../../cucumberdude/lib/api.ts), and `EXPO_PUBLIC_USE_MOCK_AUTH=false` in production builds. During Task 1's e2e, tail `vercel logs` and verify `Authorization: Bearer` is present on incoming requests. If it isn't, **stop Task 4 and fix the client first.**
- [ ] **Search endpoint is POST, not GET** — confirmed against the stub and the client. Task 6 is POST with a JSON body.
- [ ] **Multi-brand scope: Mangood only** — confirmed in rev 3. No brand-aware refactor this sprint. Task 9 adds TODO markers for the future Pomenatal migration.

---

## Parallel work streams

Three streams, assigned one owner each. If you only have two engineers, merge Streams A and B on day 1 and park Stream C until day 2.

```
Stream A — Validation, auth, deploy          Stream B — Data quality
  Task 0  Inspect + disposition 8 submissions   Task 2  Rescore + subcategory backfill (A+B)
  Task 1  Preview deploy + kill switch + e2e    Task 3  Manual QA of M2.5 (needs Task 2)
  Task 4  Enable JWT auth in production

Stream C — Features + UX + docs
  Task 6  Search POST endpoint
  Task 7  Expo search tab wiring (designer in-sprint)
  Task 8  Search suggestions endpoint
  Task 9  Audit /api/products/:id/score
  Task 5  Refresh status.md
```

---

## Task cards

### Task 0 — Inspect and disposition the submission queue

**Stream:** A · **Owner:** Backend engineer · **Estimate:** 45–75 min · **Blockers:** None

**Context:** 8 user submissions queued. PM decision: **publish the non-duplicates, reject the duplicates.** These are empirical signal and we should not leave them dormant while we build.

**Do:**
1. `npm run admin:submissions` — list all pending/in_review rows
2. For each row, run `npm run admin:review <id>` and:
   - Note Claude's confidence, OCR quality, and plausibility of extracted fields
   - Cross-check barcode against the `products` table — is it now a duplicate? (A submission queued before a seed pass may now overlap.)
   - If duplicate → reject with reason `duplicate_barcode`
   - If non-duplicate and extraction looks correct → publish via the CLI
   - If non-duplicate and extraction looks bad → reject with `ocr_failed` or `insufficient_data`
3. Write a ≤15-line note summarizing:
   - How many of the 8 would have auto-published under the current threshold (85)?
   - Confidence distribution (min/median/max)
   - Any systemic OCR failures (dark photos, glare, occluded ingredients)
   - Your recommendation: keep threshold at 85, raise it, or lower it

**Acceptance criteria:**
- [ ] All 8 submissions dispositioned (published or rejected)
- [ ] `npm run admin:submissions` returns zero pending rows after this task
- [ ] Summary note exists in Linear/Slack/commit
- [ ] PM has a threshold recommendation

**Deliberately not in scope:**
- Tuning the threshold in code (follow-up if Task 0 reveals it's needed)

**Why it matters:** 45 minutes of free signal. Shipping more M3.x work without checking is building blind.

---

### Task 1 — Preview deploy, kill switch, and e2e verification

**Stream:** A · **Owner:** Backend engineer · **Estimate:** 60–90 min · **Blockers:** Pre-flight checklist, Task 0

**Context:** M3.1 auto-publish code is in the working tree but not deployed. The prior handoff asked for a preview deploy and e2e against barcode `8718951594883`. We're also adding a kill switch so a misbehaving model can be disabled via env var without a redeploy.

**Do:**
1. Commit all M3.1 changes with a clean message
2. **Add a kill switch:** in [lib/submissions/auto-publish.ts](../lib/submissions/auto-publish.ts), gate `tryAutoPublish` on `process.env.AUTO_PUBLISH_ENABLED !== 'false'`. When disabled, return `{ kind: 'skipped', reason: 'disabled' }` immediately. Default (var absent) = enabled.
3. `vercel env add AUTO_PUBLISH_ENABLED` — set to blank/`true` in all three envs. The var must exist in Vercel so we can flip it to `false` later without touching code.
4. `vercel` (preview, not `--prod`)
5. Run the e2e: submit barcode `8718951594883` with front+back photos via `curl` or the Expo client pointed at the preview URL
6. Watch `vercel logs`; confirm the response is `{ status: 'auto_published', product_id: ... }` or `{ status: 'pending_review' }` with OCR completing — never a 500
7. Verify the row in `products` has `source='user'`, populated `score`, and `source_id = submission_id`
8. Re-scan the same barcode → should hit the cache instantly
9. **Test the kill switch:** set `AUTO_PUBLISH_ENABLED=false` on preview, submit a different test barcode, confirm the response is `{ status: 'pending_review' }` regardless of confidence. Set back to enabled.
10. **Confirm JWT presence:** while logs are tailing, confirm incoming requests include `Authorization: Bearer` (this is the Pre-flight item 3 check, done here as a side-effect)
11. Promotion to production gated on Task 3 QA

**Acceptance criteria:**
- [ ] Kill switch env var works on preview (both values tested)
- [ ] `8718951594883` submission produces either `auto_published` or `pending_review`, never a 500
- [ ] If `auto_published`: the new product is visible on subsequent scans
- [ ] If `pending_review`: logs show exactly which guardrail or confidence gate triggered
- [ ] Live preview log confirms incoming requests carry `Authorization: Bearer`

**Deliberately not in scope:**
- Promoting to production (separate call — after Task 3)

**Why it matters:** Uncommitted code can't serve users. The kill switch turns a potential "revert and redeploy" incident into a one-env-var toggle.

---

### Task 2 — Rescore + subcategory backfill (two phases, both mandatory)

**Stream:** B · **Owner:** Backend engineer · **Estimate:** Phase A: 2–3h · Phase B: 3–4h · **Blockers:** Pre-flight checklist

**Context:** Sprint goal #3 is 90% scored AND 90% subcategorized. Phase A handles products that already have ingredients (no network). Phase B refetches the 402 products that have no ingredients. **Both phases are mandatory to hit the 90% target** — Phase A alone gets to ~71%.

**Column name reminder:** the schema column is `score`, not `score_overall`. Do not write code against `score_overall`.

#### Phase A — Local rescore + subcategory fill

**Do:**
1. Create `scripts/rescore-products.ts`:
   - Select all products where `score IS NULL` and at least one row exists in `product_ingredients`
   - For each product, reconstruct the canonical `Product` shape. **Reuse the helper already used by [app/api/products/[id]/alternatives/route.ts](../app/api/products/[id]/alternatives/route.ts)** — do not re-implement ingredient fetching.
   - Call `scoreProduct({ product })` from [lib/scoring/index.ts](../lib/scoring/index.ts)
   - `UPDATE products SET score = ..., score_breakdown = ...` where id matches and `score IS NULL` (idempotent guard)
   - Log every 50 rows
2. Extend `scripts/backfill-subcategories.ts` (already exists) or create a new script:
   - Select all products where `subcategory IS NULL` AND `category IS NOT NULL` AND `name IS NOT NULL`
   - Use the existing LLM classifier code path (same as new inserts)
   - `UPDATE products SET subcategory = ...` only where currently NULL
   - Log every 25 rows (LLM calls are the bottleneck)
3. `--dry` run both first; confirm counts (~600 rescore, ~366 subcategory)
4. Run for real
5. `npm run db:coverage` — "With score" jumps 415 → ~1,015; "With subcategory" gains ~366

**Acceptance criteria (Phase A):**
- [ ] Both scripts are idempotent (re-run is safe; only `NULL → value`)
- [ ] `--dry` flag supported on both
- [ ] Coverage report shows ≥1,000 scored AND ≥1,000 subcategorized products
- [ ] No existing scores or subcategories are overwritten

#### Phase B — Refetch missing ingredients (mandatory for 90% target)

**Do:**
1. Create `scripts/refetch-missing.ts`
2. For each product with `source IN ('obf','dsld','off')` and no ingredients, refetch from the source via the existing adapters in [lib/sources/](../lib/sources/)
3. Upsert via `upsertProduct()`, which triggers scoring and subcategory classification at insert time
4. Rate-limit source calls: **≤1 request/second** to both OBF and DSLD (not `≥1/s` as rev 1 said)
5. For products where the source returns nothing, log the barcode to a triage file and leave them as-is

**Acceptance criteria (Phase B):**
- [ ] Script exists and is idempotent
- [ ] Coverage report shows **≥1,275 scored (90%)** AND **≥1,275 subcategorized (90%)**
- [ ] No 429s in logs (rate limit respected)
- [ ] Triage file lists barcodes that returned nothing from source

**Deliberately not in scope:**
- Cron job for this (one-time cleanup)
- Rescoring already-scored products
- Retry queues / idempotency keys / job infrastructure

**Why it matters:** Data quality is the real asset. This task is what makes M1.5 scan, M2.5 recommendations, M4 search, and the search suggestions endpoint all honest.

---

### Task 3 — Manual QA of M2.5 recommendations

**Stream:** B · **Owner:** Backend engineer or tester · **Estimate:** 45–90 min · **Blockers:** Task 2 (both phases)

**Context:** M2.5 is marked shipped but was implemented when the scored pool was 68 products. Now it'll run against a 1,275+ pool. We need to actually use it.

**Do:**
1. Scan three known Poor products (score < 40) — one food, one grooming, one supplement
2. For each, call `GET /api/products/{id}/alternatives` and note:
   - Did the endpoint return ≥1 alternative?
   - Same subcategory as the scanned product?
   - At least 15 points higher?
   - Do they feel "better" by common sense? (No cross-subcategory nonsense — cologne shouldn't recommend deodorant.)
3. Call `GET /api/recommendations` after a session of 3–5 scans and verify the pairs make sense.
4. Write a ≤15-line QA note: pass/fail per product, edge cases.

**Acceptance criteria:**
- [ ] Three Poor products tested across all three categories
- [ ] Alternatives endpoint returns ≥1 result for each
- [ ] Common-sense test passes
- [ ] QA note lives somewhere discoverable

**Deliberately not in scope:**
- Fixing any issues found (file them; don't fix here)
- Automated tests

**Why it matters:** Task 3 is the gate on promoting Task 1's preview to production.

---

### Task 4 — Enable authentication in production

**Stream:** A · **Owner:** Backend engineer · **Estimate:** 30–45 min · **Blockers:** Task 1 preview verified, Pre-flight item 3 confirmed

**Context:** Pre-flight item 3 confirms the Expo client is already sending `Authorization: Bearer <supabase_jwt>` in production. The server code in [lib/auth.ts](../lib/auth.ts) already verifies JWTs when `SUPABASE_JWT_SECRET` is set. The only remaining work is setting the secret and flipping the flag.

**Do:**
1. Supabase Dashboard → Settings → API → copy **JWT Secret** (not anon or service_role)
2. `vercel env add SUPABASE_JWT_SECRET` — all three environments
3. `vercel env add AUTH_ENABLED true` — all three environments
4. Redeploy preview and verify:
   - Unauthenticated request → 401
   - Request with valid JWT → 200
   - Local dev header fallback still works with `AUTH_ENABLED=false` in `.env.local`
5. Promote to production
6. **Within 5 minutes of production promotion**, scan a product via the Expo app on a real device (not simulator). This is the end-to-end confirmation.
7. **Monitor `vercel logs` for 10 minutes post-promotion.** If >5% of requests 401, flip `AUTH_ENABLED=false` immediately and investigate.

**Acceptance criteria:**
- [ ] Preview and production enforce auth
- [ ] Expo client on a real device connects successfully to production
- [ ] No sustained 401 spike in the first 10 minutes (>5% of requests)
- [ ] `ADMIN_USER_IDS` still works for `requireAdmin` (verify with the admin CLI)

**Deliberately not in scope:**
- Admin role system beyond `ADMIN_USER_IDS`
- Rate limiting

**Why it matters:** Auth was always the plan. With M3.0/M3.1 live, user attribution on submissions is now meaningful.

---

### Task 5 — Refresh docs/status.md

**Stream:** C · **Owner:** Anyone · **Estimate:** 15–30 min · **Blockers:** None

**Context:** status.md still claims M3.0/M3.1 are pending, references S3 env vars we don't use, and lists a priority order that predates this sprint plan.

**Do:**
1. Update executive summary: M1/M1.5/M2/M2.5/M3.0/M3.1 all shipped
2. Remove S3 env var references — we use `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`
3. Replace "What to Do Next" with a link to this sprint plan
4. Update Database Schema Status to include `user_submissions.reviewed_by`
5. Update env vars to include `AUTO_PUBLISH_ENABLED` (new in Task 1), `SUPABASE_JWT_SECRET` and `AUTH_ENABLED` (confirmed in Task 4)

**Acceptance criteria:**
- [ ] No mention of S3 anywhere in `docs/`
- [ ] M3.0 and M3.1 marked shipped
- [ ] "What to Do Next" points to this plan
- [ ] `grep -r TODO docs/` returns no stale items
- [ ] New env vars documented

---

### Task 6 — M4 search endpoint (POST, filtered, sorted)

**Stream:** C · **Owner:** Backend engineer · **Estimate:** 2–3h · **Blockers:** Task 2 Phase A (sparse results otherwise), Pre-flight checklist

**Context:** The stub at [app/api/products/search/route.ts](../app/api/products/search/route.ts) is POST (not GET — verified) and returns empty. The cucumberdude client at [cucumberdude/app/(tabs)/search.tsx](../../cucumberdude/app/(tabs)/search.tsx) sends a POST body with `{ query, category?, sort_by? }`. This card replaces the stub with a real implementation **that matches the client contract exactly**.

**Request shape (locked against client):**
```ts
POST /api/products/search
Body: {
  query: string;                                // can be empty for browse mode
  category?: 'food' | 'grooming' | 'supplement';
  subcategory?: string;                         // NEW — add to SearchFilters
  min_score?: number;
  sort_by?: 'relevance' | 'best_rated';         // NEW — client already sends this
  limit?: number;                               // max 50, default 20
  offset?: number;                              // default 0
}
Response: PaginatedResponse<Product>
```

**Do:**
1. Extend [types/guardscan.ts](../types/guardscan.ts) `SearchFilters` to add `subcategory?` and `sort_by?`. **Coordinate with the cucumberdude types file** — per CLAUDE.md, these must stay in sync. Commit the corresponding change in cucumberdude in the same PR window.
2. Replace the stub:
   - `WHERE (name ILIKE $1 OR brand ILIKE $1)` when `query.length >= 2`; skip the filter entirely in browse mode
   - `AND category = $2` if present
   - `AND subcategory = $3` if present
   - `AND score >= $4` if present
   - Default sort: `ORDER BY CASE WHEN name ILIKE $1 THEN 0 ELSE 1 END, score DESC NULLS LAST, name ASC` (rough relevance)
   - `sort_by='best_rated'` sort: `ORDER BY score DESC NULLS LAST, name ASC`
   - `LIMIT $5 OFFSET $6`, limit capped at 50
3. Use existing indexes (`products_category_score_idx`, `products_subcategory_score_idx`) — no new indexes
4. Input validation: limit bounds, category/sort_by enum check, subcategory length cap
5. Test on preview:
   - `curl -X POST preview/api/products/search -d '{"query":"old spice","category":"grooming"}'`
   - `curl -X POST preview/api/products/search -d '{"query":"","category":"grooming","sort_by":"best_rated"}'` (browse)
   - `curl -X POST preview/api/products/search -d '{"query":"protein","subcategory":"protein_powder","min_score":50}'`

**Acceptance criteria:**
- [ ] Endpoint returns real paginated results
- [ ] Empty query with filters = browse mode works
- [ ] `sort_by='best_rated'` visibly reorders (not silently ignored)
- [ ] Subcategory filter works
- [ ] Response matches `PaginatedResponse<Product>`
- [ ] p95 latency < 500ms on a 1,400-row catalog
- [ ] `types/guardscan.ts` updated in both repos (guardscan-api + cucumberdude)

**Deliberately not in scope:**
- tsvector, pg_trgm, GIN indexes (revisit at 10k+ rows)
- Typo tolerance / fuzzy matching
- Search analytics / query logging
- Algolia/Meilisearch/Typesense — our catalog is 1,400 rows

---

### Task 7 — Expo search tab wiring + empty states (designer in-sprint)

**Stream:** C · **Owner:** Frontend engineer + Product Designer · **Estimate:** 3–5h · **Blockers:** Task 6 (endpoint), Task 8 (suggestions)

**Context:** The cucumberdude search tab at [cucumberdude/app/(tabs)/search.tsx](../../cucumberdude/app/(tabs)/search.tsx) currently runs against the mock API. PM decision: designer is in-sprint. This card points the tab at the real backend and polishes the states real users will see.

**Do:**
1. Set `EXPO_PUBLIC_USE_MOCK_API=false` and `EXPO_PUBLIC_API_URL` to the preview URL in the dogfood build profile
2. Verify the POST body matches the Task 6 contract; update `SearchFilters` in the client types to include `subcategory` and `sort_by`
3. Designer reviews real results against the dense catalog:
   - **Empty state before search** — confirm copy still works
   - **Zero results state** — current "try different keywords" copy; validate against real misses
   - **Loading skeleton** — 3 placeholders; confirm fit against real card dimensions
   - **Autocomplete** — depends on Task 8; if Task 8 isn't done, hide suggestions behind a flag
   - **Best rated toggle** — confirm backend now honors `sort_by` (Task 6)
   - **Category dropdown default** — currently "grooming" per cucumberdude code; PM default is to keep it unless overridden
4. **Fix the recall permission copy** (App Store risk) — edit [cucumberdude/brands/mangood.ts:138](../../cucumberdude/brands/mangood.ts) `notificationPermissionReason`. Current copy: *"Mangood sends alerts about product recalls and safety updates."* We have zero recall infrastructure and asking for push permission under a false pretext is an Apple Review 5.1.1 risk. Change to: *"Mangood sends product safety updates and scan reminders."* (30-second change, client-side only.)
5. Ship an internal TestFlight / APK build for dogfooding
6. File any UX issues as separate tickets — do not fix in this card

**Acceptance criteria:**
- [ ] Search tab returns real results from preview backend
- [ ] "Best rated" toggle produces visibly different ordering
- [ ] Category dropdown narrows results
- [ ] Empty/loading/zero-result states pass designer review
- [ ] Recall permission copy softened in `brands/mangood.ts`
- [ ] Dogfood build is on internal testers' phones

**Why it matters:** This is the only user-visible artifact in the sprint. Without designer review, we ship a search tab full of real data in states designed against mock data.

---

### Task 8 — Implement `/api/products/search/suggestions`

**Stream:** C · **Owner:** Backend engineer · **Estimate:** 1–2h · **Blockers:** Task 2 Phase A

**Context:** The Expo client calls `GET /api/products/search/suggestions?q=...&category=...` for autocomplete ([cucumberdude/lib/api.ts](../../cucumberdude/lib/api.ts)). This endpoint **does not exist on the backend** — it 404s today. The Expo tab only works because the client is currently in mock mode.

**Do:**
1. Create `app/api/products/search/suggestions/route.ts`
2. Signature: `GET /api/products/search/suggestions?q=<string>&category=<food|grooming|supplement>`
3. Query: `SELECT id, name, brand, category FROM products WHERE (name ILIKE $1 OR brand ILIKE $1) [AND category = $2] AND score IS NOT NULL ORDER BY score DESC NULLS LAST, name ASC LIMIT 8`
4. Prefix match pattern: `q + '%'` (suggestions are prefix-biased; full search is still substring)
5. Response: `{ suggestions: Array<{ id, name, brand, category }> }`
6. Minimum 2 characters required; <2 chars returns `{ suggestions: [] }`
7. Cache headers: `public, s-maxage=60, stale-while-revalidate=300`
8. Debouncing is a client concern (already 200ms in cucumberdude)

**Acceptance criteria:**
- [ ] Endpoint returns ≤8 suggestions
- [ ] `q` shorter than 2 chars returns empty array
- [ ] Case-insensitive match
- [ ] Category filter works
- [ ] Only surfaces products with `score IS NOT NULL` (no "mystery products" in autocomplete)
- [ ] p95 latency < 200ms

**Deliberately not in scope:**
- Fuzzy matching / typo tolerance
- Ranking by user history
- Materialized views

---

### Task 9 — Multi-brand future-proofing (markers + migration doc)

**Stream:** C · **Owner:** Any engineer · **Estimate:** 15–30 min · **Blockers:** None

**Context:** guardscan-api is Mangood-only today, but the infrastructure is intended to be reused for Pomenatal later. A code audit in rev 3 confirmed the following files carry **Mangood-specific assumptions** that will need brand-scoping when Pomenatal onboards:

| File | Mangood-specific assumption |
|---|---|
| [types/guardscan.ts:102-107](../types/guardscan.ts#L102-L107) | `LifeStage` type only has Mangood values (`actively_trying_to_conceive`, `testosterone_optimization`, `athletic_performance`, `longevity_focus`, `general_wellness`). Pomenatal needs pregnancy/postpartum variants. |
| [lib/scoring/constants.ts:53-59](../lib/scoring/constants.ts#L53-L59) | `LIFE_STAGE_MULTIPLIERS` is keyed to the Mangood `LifeStage` type. Pomenatal's multipliers will differ — some ingredients neutral for adult men are dangerous during pregnancy. |
| [lib/dictionary/seed.ts](../lib/dictionary/seed.ts) | The 147 curated entries are Mangood-biased. Pomenatal needs its own seed subset. |
| [lib/classify/](../lib/classify/) (LLM subcategory classifier prompt) | Prompt is tuned for grooming / men's supplements / food. Pomenatal's product mix (prenatal vitamins, maternal food, postpartum care) will miss-classify with the current prompt. |

**The goal is NOT to refactor any of this now.** That's wasted work without a concrete Pomenatal launch date. The goal is to make the future refactor findable with one `grep`.

**Do:**
1. Add a `// TODO(multi-brand): ...` comment at the top of each of the four files above, briefly describing what needs to change when Pomenatal joins. Example:
   ```ts
   // TODO(multi-brand): LifeStage enum is Mangood-biased (men's-health values only).
   // When Pomenatal onboards, extend with pregnancy/postpartum values or extract
   // to a brand-scoped type. See docs/multi-brand-migration.md.
   ```
2. Create [docs/multi-brand-migration.md](./multi-brand-migration.md) — one page, listing:
   - Current state: guardscan-api is Mangood-only
   - Files that need to change (reuse the table above)
   - Suggested approach: brand-scoped config object passed through scoring, not global constants
   - NOT a detailed plan — a sketch for the future sprint
3. Do NOT introduce any brand parameter, brand column, or brand config in code this sprint. Keep the change surface to comments + one doc file.

**Acceptance criteria:**
- [ ] Four `// TODO(multi-brand):` markers added, each with a one-sentence description
- [ ] `grep -r "TODO(multi-brand)" .` returns the four expected hits
- [ ] [docs/multi-brand-migration.md](./multi-brand-migration.md) exists and is ≤1 page
- [ ] No production code paths touched

**Why it matters:** 15 minutes now saves a week of archaeology when Pomenatal onboards. The alternative — discovering Mangood assumptions by breakage during a future sprint — is expensive.

---

## Multi-brand context (resolved)

The cucumberdude client is white-label and supports two brands:

| Brand | Focus | Status |
|---|---|---|
| **Mangood** | Men's health & grooming | **Current target of guardscan-api** |
| **Pomenatal** | Postpartum/maternal | Planned — will reuse this infrastructure |

**Decision (PM, rev 3):** guardscan-api is Mangood-only today. The infrastructure is intended to serve Pomenatal later, sharing the same codebase. No brand-scoped refactor happens in this sprint.

**What this means for each task:**

- **Task 2 Phase B (refetch)** — refetch by arbitrary source order; no brand-weighted prioritization. Mangood's product mix is already densest.
- **Task 2 Phase A (subcategory backfill)** — LLM classifier uses its current (Mangood-tuned) prompt. No changes.
- **Task 6 (search)** — no `brand_scope` column or filter. All products belong to Mangood.
- **Task 9** — adds TODO markers so the future Pomenatal migration can `grep` for Mangood-specific assumptions.

**What's explicitly deferred to a future "Pomenatal onboarding" sprint:**

- Brand column on `products`, `user_submissions`, and potentially `profiles`
- Brand-scoped life-stage multipliers in [lib/scoring/constants.ts](../lib/scoring/constants.ts)
- Brand-scoped dictionary entries
- Brand-tuned LLM classifier prompts
- Brand-specific seed scripts
- Per-brand Supabase project / auth pool question (may or may not stay separate)

---

## Overengineering audit

### Things we are NOT building

| Proposed | Why we're skipping |
|---|---|
| S3 for photo storage | Supabase Storage already works. One provider, one bill. |
| Vercel Blob migration | Same reason. |
| Algolia / Meilisearch / Typesense | 1,400 rows. Postgres ILIKE handles this. Revisit at 10k+. |
| Full-text search with tsvector | YAGNI until users complain about ILIKE missing hits. |
| Custom admin web UI | CLI is enough until 20 submissions/week. See admin dashboard section. |
| Cron job for rescore | One-time cleanup. Script is correct. |
| Retry queues for submissions | `after()` handles it. Adding a queue is premature. |
| Rate limiting on `/api/products/submit` | File-size + MIME checks in place. Add when abuse appears. |
| M3.2 on-device auto-crop | Correctly deferred. Revisit in 4 weeks. |
| Automated regression tests | Manual QA (Task 3) first. Automate once stable. |
| Batch OCR processing | Inline runs in ~10s. No batch problem to solve. |
| Brand-scoped life-stage multipliers | Only if PM confirms guardscan-api serves both brands. Default: Mangood-only. |

### Things worth simplifying

- **Rescore pass split into Phase A/B.** Phase A is ~1h for 60% of the value (no network). Phase B is ~3h for the remaining 30%. Ship A first, then B.
- **M4 search scope.** ILIKE on 1,400 rows is fine. Save the 4 hours budgeted for tsvector.

---

## Supabase-first: confirmed architecture

No migration planned for MVP.

| Concern | Provider | Evidence |
|---|---|---|
| Postgres | Supabase (US East, transaction pooler) | [db/client.ts](../db/client.ts), `DATABASE_URL` env |
| Auth | Supabase Auth (via Expo client) | JWT verification activated in Task 4 |
| Object storage | Supabase Buckets (`submissions` bucket, private) | [lib/storage/supabase.ts](../lib/storage/supabase.ts) |
| Admin queries | Supabase Studio (web SQL editor) | No custom tooling needed |

Don't introduce Vercel Blob, Vercel KV, Neon, or Upstash. Consolidating on one provider keeps the bill and mental model simple.

---

## Admin dashboard: current state + trigger

**Today:** CLI only. [scripts/admin-submissions.ts](../scripts/admin-submissions.ts) lists pending submissions, prints signed photo URLs, shows Claude's extraction, and publishes on `y`. Supabase Studio covers ad-hoc SQL.

**Trigger to build Option A (Next.js admin route):** **20 submissions/week** (locked by PM). When weekly submission volume crosses this line:

- Add a query to [scripts/db-coverage.ts](../scripts/db-coverage.ts) that surfaces weekly submission count from `user_submissions.created_at`. Run it during weekly review so we catch the threshold crossing.
- Build `app/admin/submissions/page.tsx` + related API routes, protected by `ADMIN_USER_IDS`. ~1 day of work, same repo, same deploy, same auth.

**Not Option B or C.** Supabase Studio can't trigger `publishExtracted`. Retool/Forest/Appsmith add vendor surface for a problem Option A solves in a day.

---

## What's deferred (explicit)

- **M3.2 — on-device auto-crop.** Deferred 4 weeks post-launch per the M3 doc.
- **Expo "added instantly" celebration UX** — client-side polish on `status === 'auto_published'`.
- **Admin web dashboard** — see trigger above.
- **M5 — commercial provider fallback.** Not MVP-blocking. Revisit if unknown barcodes cause measurable drop-off.
- **Automated tests** — post-manual-QA.
- **Rate limiting on submit** — defer until abuse is observed.
- **Push notifications for actual recalls.** No backend infrastructure for product recalls exists. The *user-facing promise* of recalls is softened in Task 7 (permission copy fix). Real recall infrastructure — FDA/FSIS feed ingestion, cross-reference to catalog, targeted push — is deferred post-MVP. A minimal intermediate option (a `product_recalls` table + admin CLI to push a manual recall) is ~2 hours if a specific recall event forces our hand before we build the full pipeline.
- **Photo retention policy.** Per PM: **keep forever.** No lifecycle rules in the `submissions` bucket. Add a storage cost line to the monthly review after launch.
- **Pomenatal onboarding.** Separate future sprint. Task 9 adds `TODO(multi-brand)` markers to the four files that will need changes. See [docs/multi-brand-migration.md](./multi-brand-migration.md) (created in Task 9) for the sketch.
- **Dead-code cleanup in cucumberdude.** [lib/api.ts:195](../../cucumberdude/lib/api.ts) exports `products.score()` which no screen calls. File a one-line cleanup ticket in the cucumberdude repo for post-MVP — not a guardscan-api task.

---

## Sequencing cheat sheet

```
Day 1 (Mon) — kickoff
  All:          Pre-flight checklist (30 min)
  Stream A:     Task 0 → Task 1 (includes kill switch)
  Stream B:     Task 2 Phase A (rescore + subcategory)
  Stream C:     Task 5 (docs, anyone with spare cycles)

Day 2 (Tue) — parallel feature + data
  Stream A:     Task 4 (auth flip on preview)
  Stream B:     Task 2 Phase B (refetch)
  Stream C:     Task 6 + Task 8 (endpoint + suggestions)

Day 3 (Wed) — QA, designer, promotion
  Stream B:     Task 3 (M2.5 QA against dense pool)
  Stream C:     Task 7 (Expo wiring + designer review + recall copy fix)
                Task 9 (multi-brand TODO markers + migration doc, 15 min)
  Stream A:     Task 4 production flip (gated on Expo dogfood success)
  All:          Promote Task 1 to production (gated on Task 3 pass)

Day 4 (Thu) — buffer + real-device dogfood
  Fix anything filed during Task 3 / Task 7
  Monitor auto-publish queue, monitor 401 rate
```

**Minimum viable sprint** (if one engineer is sick or unavailable): Tasks 0, 1, 2A, 2B, 3, 4, 6, 8. Defer Task 7 (designer review) and Task 9 (multi-brand markers) to follow-ups. **Auth (Task 4) is in the MVP per PM decision — do not defer.** Do NOT defer the Task 7 recall copy fix — it's 30 seconds and removes an App Store risk; pull it out of Task 7 and into Task 1 if Task 7 slips.

---

## Questions for PM/PD

**Zero open questions.** All prior items are either answered or closed with a default in rev 3. The defaults below apply unless PM explicitly overrides before kickoff:

- **Search tab default category →** keep "grooming" (matches Mangood brand positioning; the only product the client ships today).
- **Task 1 production promotion sign-off →** PM approves promotion after (a) Task 3 M2.5 QA notes pass and (b) Task 4 preview auth verification shows no 401 spike. Process, not a decision.

---

## Answered history

### rev 3 (2026-04-11)
- Multi-brand scope → **Mangood only today; Pomenatal reuses this infra later** (Task 9 adds TODO markers)
- `/api/products/:barcode/score` → **dead code in client, no backend work** (Task 9 repurposed)
- Recalls in permission copy → **soften the copy in Task 7** (App Store 5.1.1 risk; 30-second fix)
- Search tab default category → **keep "grooming"** (default)
- Task 1 production sign-off → **process clarified, PM approves post-Task 3 + Task 4 preview**

### rev 2 (2026-04-11)
- Auth in MVP → **yes** (Task 4 is mandatory)
- Coverage target → **90% scored + 90% subcategorized** (Task 2 A+B both mandatory)
- Subcategory filter in search → **yes** (Task 6 includes it)
- Designer in-sprint → **yes** (Task 7)
- 8 pending submissions → **publish non-duplicates, reject duplicates** (Task 0)
- Photo retention → **keep forever** (documented in Deferred)
- Admin dashboard trigger → **20 submissions/week** (documented in Admin section)
- Auto-publish rollback story → **env-var kill switch** (added to Task 1)
- Expo client auth header → **already sends `Authorization: Bearer <jwt>`** in production (verified in cucumberdude/lib/api.ts)
- Search endpoint verb → **POST** (verified; Task 6 matches client)

---

## References

- [docs/roadmap.md](./roadmap.md) — milestone-level goals
- [docs/status.md](./status.md) — **stale**, scheduled for update in Task 5
- [docs/milestones/m3-user-submissions.md](./milestones/m3-user-submissions.md) — shipped M3.0/M3.1 pipeline
- [CLAUDE.md](../CLAUDE.md) — codebase conventions
- [cucumberdude/README.md](../../cucumberdude/README.md) — Expo client (white-label, Mangood + Pomenatal)
- [cucumberdude/lib/api.ts](../../cucumberdude/lib/api.ts) — client API contract (source of truth for Task 6 / Task 8 request shapes)

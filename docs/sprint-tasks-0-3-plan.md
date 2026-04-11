# Sprint Tasks 0–3 — Pre-flight Findings & Execution Plan

**Author:** Claude (engineering assistant)
**Date:** 2026-04-11
**Scope:** Tasks 0, 1, 2 (A+B), 3 from [docs/mvp-sprint-plan.md](./mvp-sprint-plan.md)
**Status:** Awaiting PM/eng go-ahead before any destructive or deploy step.

---

## TL;DR

- Pre-flight checklist passes on every item **except one**: the 90%-scored coverage target in Task 2 is mathematically unreachable without implementing supplement scoring, which is out of sprint scope.
- All prerequisite code (adapters, `upsertProduct`, `publishExtracted`, the existing subcategory backfill) is in place and reusable. Task 2A and Task 2B can be built by composing existing helpers; no new infra needed.
- Task 0's admin CLI is interactive-only today — it blocks on a `readline` prompt, so it can't be run unattended. A small, non-interactive extension is the cleanest fix.
- Execution order below is designed so that all code lands first (reversible), and every prod-affecting step (DB writes, Vercel deploy, env-add, submission publish) pauses for explicit approval.

---

## 1. Pre-flight findings

### 1.1 Checklist verification

| Pre-flight item | Result | Notes |
|---|---|---|
| Schema column is `score`, not `score_overall` | ✅ | [db/schema.ts:37](../db/schema.ts#L37) confirms `score: smallint('score')`. |
| Local env vars present | ✅ | `.env` has `DATABASE_URL`, `OFF_USER_AGENT`, `OPENROUTER_API_KEY`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `ADMIN_USER_IDS`. `vercel env ls preview` still needs to be verified by whoever runs Task 1. |
| Expo client sends JWTs in prod | Not yet re-verified | Will be checked during Task 1 log tail (plan item). |
| Search endpoint is POST | ✅ (out of scope for this doc) | Confirmed by prior rev of the sprint plan. |
| Multi-brand scope: Mangood only | ✅ | No brand-scoped refactor needed for Tasks 0–3. |

### 1.2 Catalog state (from `npm run db:coverage`, 2026-04-11)

```
Total rows:             1417
With score:             415
With score breakdown:   415
Missing score:          1002
Missing subcategory:    366
Products with ≥1 ingredient: 1015 / 1417
Total ingredient rows:       20567 (avg 20.3 per product)

By category:
  food             2
  grooming       812
  supplement     603

By source:
  dsld           603
  obf            812
  off              2

User Submissions — By Status:
  in_review    1
  pending      7
```

- 1,015 rows have ≥1 ingredient; 415 have a score ⇒ **~600 rows are one local rescore away from a score** (matches the sprint plan's estimate).
- 402 rows have **no ingredients** (1,417 − 1,015) and need a source refetch.
- 366 rows have **no subcategory**. Full LLM backfill applies cleanly; the existing `scripts/backfill-subcategories.ts` already handles it.

### 1.3 Reusable building blocks verified

| Helper | File | Used for |
|---|---|---|
| `upsertProduct(db, product, source, score, subcategory, sourceId)` | [lib/cron/ingest-helpers.ts](../lib/cron/ingest-helpers.ts) | Canonical insert path; triggers subcategory LLM fallback inside when subcategory arg is null. Reused by Task 2A rescore, Task 2B refetch, and both publish paths. |
| `publishExtracted(...)` | [lib/submissions/auto-publish.ts](../lib/submissions/auto-publish.ts) | Shared publish path — both CLI and auto-publish call it. Task 0 programmatic publishes reuse this. |
| `scoreProduct({ product, lifeStage?, nutriscoreScore? })` | [lib/scoring/index.ts](../lib/scoring/index.ts) | Pure function; Task 2A can call it in a tight loop. |
| `inferSubcategoryHybrid(name, category)` | [lib/llm/classifier.ts](../lib/llm/classifier.ts) | Keyword → LLM hybrid. Used inside `upsertProduct` and `backfill-subcategories.ts`. |
| `normalizeOffProduct` / `normalizeObfProduct` / `normalizeDsldLabel` | [lib/normalize.ts](../lib/normalize.ts) | Source payload → canonical `Product`. Task 2B refetch reuses these directly. |
| `fetchOffProduct` / `fetchObfProduct` / `fetchDsldLabel` | [lib/sources/*.ts](../lib/sources/) | One-barcode fetch. DSLD requires the numeric `sourceId`, not the barcode — important for Task 2B. |

### 1.4 Gaps discovered

1. **Supplement scoring is still a stub.** [lib/scoring/index.ts:40](../lib/scoring/index.ts#L40) explicitly returns `null` for `category === 'supplement'`. See §2 for the coverage-target impact.
2. **Admin CLI has no non-interactive publish path.** [scripts/admin-submissions.ts](../scripts/admin-submissions.ts) implements `list`, `review <id>` (readline-driven), and `reject <id> <reason>`. There is no `publish <id>` or `inspect <id>` command, so Task 0 cannot be executed programmatically today.
3. **Kill switch not yet in code.** `tryAutoPublish` in [lib/submissions/auto-publish.ts](../lib/submissions/auto-publish.ts) has no env-var gate. Task 1 adds one.
4. **No rescore script exists.** `scripts/rescore-products.ts` and `scripts/refetch-missing.ts` must be created.
5. **DSLD refetch is barcode-free.** DSLD has no barcode lookup. The refetch script has to use the stored `source_id` (DSLD numeric label id) via `fetchDsldLabel`, not a barcode-based path.

---

## 2. Blocker: Task 2 coverage target vs. supplement scoring stub

**The problem.** The sprint plan locks the Task 2 target at "≥1,275 scored (90%) AND ≥1,275 subcategorized (90%)." With 603 supplements (43% of the catalog) and `scoreProduct` returning `null` for supplements unconditionally, the arithmetic is:

```
Max scorable rows = 814 (food + grooming)
Max scored coverage = 814 / 1417 = 57.4%
Required for 90%     = 1275 / 1417
Gap                  = 461 rows that only supplement scoring can close
```

Subcategory is not affected — the classifier works on all three categories, so 90% subcategorized is achievable.

**Options.**

| Option | Cost | Pro | Con |
|---|---|---|---|
| **A. Reinterpret the target** as "≥90% of *scorable* products" (food + grooming) and note the supplement gap in the sprint summary | 0 extra hours | Hits 733+ scored, aligns with what the existing code can actually compute, keeps Tasks 0–3 in their box | PM messaging: "90% scored" no longer literal; users scanning supplements still see no score |
| **B. Implement a minimal supplement scorer** (e.g., reuse food-grooming logic against the DSLD ingredient list with no life-stage multiplier) | ~3–5h extra | Hits a literal 90% number | New scoring logic ships without QA, life-stage-multiplier semantics are undefined for supplements, risks wrong scores on launch |
| **C. Hold Task 2 until supplement scoring is specced** | Days | Correct scores for all three categories | Task 2 blocks Tasks 3, 4, 6, 7 for the entire sprint — unacceptable |

**Recommendation: Option A.** Reinterpret, document, and ship. Option B adds scoring logic that no one has reviewed, and supplements legitimately need a different model (quality/purity/dose, not ingredient-position deduction). Ship what's honest now, prioritize supplement scoring as its own card next sprint.

**Decision (2026-04-11): Option A confirmed.** Coverage target reinterpreted as ≥90% of scorable (food + grooming) rows. Supplement gap documented in sprint summary.

---

## 3. Execution plan

All code changes land first (reversible, local). Every prod-affecting step has an explicit pause for go/no-go. Scripts support `--dry` where applicable.

### 3.1 Code changes (safe, no external side effects)

#### 3.1.1 Task 1 — Kill switch

**File:** [lib/submissions/auto-publish.ts](../lib/submissions/auto-publish.ts)
**Change:** Gate `tryAutoPublish` on `process.env.AUTO_PUBLISH_ENABLED !== 'false'`. When disabled, return immediately:

```ts
if (process.env.AUTO_PUBLISH_ENABLED === 'false') {
  return { kind: 'skipped', reason: 'disabled' };
}
```

**Type impact:** Extend the `AutoPublishResult['skipped']['reason']` union to include `'disabled'`.

#### 3.1.2 Task 0 helper — Non-interactive admin commands

**File:** [scripts/admin-submissions.ts](../scripts/admin-submissions.ts)
**New commands:**

- `inspect <id>` — prints OCR pre-fill, Claude's confidence, whether the barcode is already present in `products` (duplicate check), and the signed front/back URLs. Read-only, no state mutation.
- `publish <id>` — publishes using OCR-extracted fields verbatim through `publishExtracted`. Non-interactive. `reviewedBy` set to the first `ADMIN_USER_IDS` entry.

`reject <id> <reason>` already exists and is non-interactive.

#### 3.1.3 Task 2A — `scripts/rescore-products.ts`

**Behavior:**
1. Load env from `.env` (same pattern as `db-coverage.ts`).
2. Select products where `score IS NULL` AND there exists ≥1 row in `product_ingredients`.
3. For each row:
   - Hydrate ingredients from `product_ingredients` in position order.
   - Build a canonical `Product` inline (same shape as `alternatives/route.ts` reconstruction) — `data_completeness: 'full'`, `ingredient_source: row.source === 'dsld' ? 'verified' : 'open_food_facts'`.
   - Call `scoreProduct({ product })`.
   - **Guard: if result is null (supplement, or too-sparse ingredients), skip — do not overwrite NULL with NULL.**
   - `UPDATE products SET score = $1, score_breakdown = $2 WHERE id = $3 AND score IS NULL`.
4. Log progress every 50 rows.
5. `--dry` supported; `--limit N` supported.
6. Idempotent by construction (WHERE `score IS NULL` guard).

Subcategory backfill is handled by the existing [scripts/backfill-subcategories.ts](../scripts/backfill-subcategories.ts) — no new script needed there; I'll just run it.

#### 3.1.4 Task 2B — `scripts/refetch-missing.ts`

**Behavior:**
1. Load env.
2. Select products where `source IN ('off','obf','dsld')` AND there is no row in `product_ingredients`.
3. Bucket by source. For each source, sleep 1s between requests (≤1 req/s limit).
4. Per row:
   - `off` → `fetchOffProduct(row.barcode)` → `normalizeOffProduct` → `upsertProduct`
   - `obf` → `fetchObfProduct(row.barcode)` → `normalizeObfProduct` → `upsertProduct`
   - `dsld` → `fetchDsldLabel(row.sourceId)` → `normalizeDsldLabel(label, row.barcode)` → `upsertProduct` (use `row.sourceId` because DSLD has no barcode lookup)
5. If the source returns null, append the barcode to a triage file `./tmp/refetch-triage.txt`.
6. `upsertProduct` does the scoring + subcategory fallback inside; we don't call them separately here.
7. `--dry` supported; `--limit N` supported; `--source off|obf|dsld` filter supported.
8. Total wall-clock estimate: ~812s OBF + ~603s DSLD ≈ 24 minutes minimum. Food volume is 2 rows so OFF is negligible.

### 3.2 Prod-affecting execution (each step paused for approval)

| Step | Action | Blast radius | Reversible? |
|---|---|---|---|
| **0a** | Run `admin:inspect` against all 8 submissions, print summary table, confirm which are duplicates | Read-only | n/a |
| **0b** | `admin:publish <id>` for non-duplicates, `admin:reject <id> duplicate_barcode` for duplicates | Mutates `user_submissions.status` + inserts rows into `products` for publishes | Partially — rejected submissions can be set back to `pending`; published products can be deleted by barcode |
| **2A-dry** | `tsx scripts/rescore-products.ts --dry` | Read-only | n/a |
| **2A-real** | `tsx scripts/rescore-products.ts` | ~600 rows get `score` set | Yes — clearable with `UPDATE products SET score = NULL WHERE ...` (idempotency guard makes re-runs safe) |
| **2A-sub-dry** | `npm run db:backfill:subcategory -- --dry` | Read-only | n/a |
| **2A-sub-real** | `npm run db:backfill:subcategory` | ~366 rows get `subcategory` set | Yes — clearable |
| **2B-dry** | `tsx scripts/refetch-missing.ts --dry` | Read-only | n/a |
| **2B-real** | `tsx scripts/refetch-missing.ts` | Up to ~402 rows updated via upsert; external OBF/DSLD calls at ≤1 req/s | Mostly — existing rows are upserted in place, ingredients replaced |
| **1a** | Commit M3.1 working tree + kill-switch change | Local git op | Yes |
| **1b** | `vercel env add AUTO_PUBLISH_ENABLED` (all three environments) | Vercel project env | Yes — `vercel env rm` |
| **1c** | `vercel` (preview, not `--prod`) | New preview deploy | Yes — previews don't serve prod traffic |
| **1d** | e2e submit of barcode `8718951594883` against preview URL | One submission row + possibly one new `products` row | Yes — delete by submission id |
| **1e** | Kill-switch test: set preview env to `false`, submit a different test barcode, confirm `pending_review`, set back to enabled | Env-var toggle + one submission row | Yes |
| **3**  | Manual QA: hit `GET /api/products/:id/alternatives` and `GET /api/recommendations` against three Poor products (one per category) | Read-only | n/a |

**Task 3 caveat.** With supplements unscored under Option A, the supplement arm of Task 3 will have no "Poor" supplement to test against. I'll note that in the QA write-up and substitute a Poor grooming product instead, or skip the supplement case entirely pending PM direction.

---

## 4. Decisions (2026-04-11)

1. **Task 2 coverage target → Option A.** ≥90% of scorable rows (food + grooming). Supplements out of scope this sprint.
2. **Vercel CLI steps (Task 1):** Operator runs them. Claude builds code + hands off the exact commands; operator executes `vercel env add`, `vercel deploy`, and the e2e curl.
3. **Submission publish rule (step 0b):** Structural only — publish if OCR ran + name present + valid category + ≥2 ingredients + barcode not already in `products`. No confidence floor for the manual operator path.
4. **Task 2B:** Dry run only for initial approval. Real fetch against OBF/DSLD requires a separate explicit go-ahead after dry-run results are reviewed.

**Spec patch (gap found during assessment):** The `inspect <id>` command must be fully read-only — it must NOT write `status = 'in_review'` (unlike the existing `review` command). The `publish <id>` command must accept both `pending` and `in_review` input statuses, because one submission is already `in_review` and the `list` command (filtered to `pending`) won't surface it. Note this for implementer.

---

## 5. Deliverables checklist

Code changes (lands before any prod action):

- [ ] Kill switch in `lib/submissions/auto-publish.ts`
- [ ] `inspect` and `publish` commands in `scripts/admin-submissions.ts`
- [ ] `scripts/rescore-products.ts` (idempotent, `--dry`, `--limit`)
- [ ] `scripts/refetch-missing.ts` (idempotent, `--dry`, `--limit`, `--source`)

Execution artifacts (lands after approval):

- [ ] Task 0 disposition summary (per-submission decision + confidence distribution + threshold recommendation)
- [ ] Task 2A coverage delta report (before → after numbers from `db:coverage`)
- [ ] Task 2B triage file at `./tmp/refetch-triage.txt` listing barcodes that returned nothing
- [ ] Task 1 preview URL, e2e response for `8718951594883`, kill-switch verification log
- [ ] Task 3 QA note (≤15 lines) covering three products across categories (with supplement caveat)
- [ ] Final status update to this doc marking each execution step ✅ or ❌

---

## 6. Out of scope (will not touch in Tasks 0–3)

- Supplement scoring logic
- Production promotion of the preview deploy (gated on Task 3 sign-off — a separate call)
- Auth flip (`SUPABASE_JWT_SECRET` / `AUTH_ENABLED`) — that's Task 4
- Any cucumberdude (Expo client) change
- Search endpoints and suggestions (Tasks 6 and 8)
- Admin web dashboard
- Pre-existing unrelated working-tree change in [docs/mvp-sprint-plan.md](./mvp-sprint-plan.md) (will not commit as part of this work)

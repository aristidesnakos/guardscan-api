# GuardScan API — Implementation Status

**Last updated:** 2026-04-09
**Current focus:** M3.0 preparation (M1.5, M2, M2.5 complete)

---

## Executive Summary

**Completed:** M1 (core schema), M1.5 (multi-source scanning), M2 (cron ingest), M2.5 (recommendations)
**In progress:** M3 documentation (phased user submissions strategy)
**Blocked:** SUPABASE_JWT_SECRET setup (small 1-hour fix)
**Pending:** M3.0–M3.2 (submissions + OCR), M4 (search), M5–M6 (future)

---

## Milestone Status

### ✅ M1 — Schema + Scan via OFF

**Status:** Done (⚠️ 1 pending task)

What's working:
- `GET /api/products/scan/:barcode` returns scored products from OFF
- Supabase Postgres connected and operational (US East region, transaction pooler)
- DB schema applied: `products`, `product_ingredients`, `ingredient_dictionary`, `user_submissions`, `cronState`, `scanEvents`
- Background cache writes via Next.js `after()` callback
- CORS proxy for Expo Web / browser clients
- Deployed on Vercel Fluid Compute (region `iad1`)

**⚠️ Pending:** `SUPABASE_JWT_SECRET` configuration
- **Why:** Needed for Bearer token verification (auth not yet enabled in M1)
- **Impact:** Low for MVP (auth is disabled), but **required before** moving to M1.5 hardening
- **Action:** 1 hour setup task
  1. Supabase Dashboard → Settings → API → JWT Settings
  2. Copy JWT Secret (NOT anon key or service_role key)
  3. Add to `.env`: `SUPABASE_JWT_SECRET=...`
  4. Add to Vercel: `vercel env add SUPABASE_JWT_SECRET`
  5. Set `AUTH_ENABLED=true` when ready

---

### ✅ M1.5 — Multi-Source Scanning + Dictionary Growth

**Status:** Done

Implemented (commit `8362106`):
- ✅ OBF (Open Beauty Facts) adapter for grooming products
- ✅ DSLD (NIH Dietary Supplement Label Database) adapter for supplements
- ✅ Parallel OFF + OBF lookup (first non-null wins)
- ✅ Subcategory inference (`lib/subcategory.ts`)
- ✅ Dictionary expanded from ~60 to ~300 entries
- ✅ Ingredient normalization for OBF + DSLD products
- ✅ Scan route prioritizes OBF when OFF detects grooming category

Code locations:
- Sources: `lib/sources/openbeautyfacts.ts`, `lib/sources/dsld.ts`
- Normalization: `lib/normalize.ts` — `normalizeObfProduct()`, `normalizeDsldLabel()`
- Dictionary: `lib/dictionary/seed.ts` (~300 entries)
- Scan route: `app/api/products/scan/[barcode]/route.ts` (lines 233–259 parallel lookup)

---

### ✅ M2 — Cron Ingest (OBF + DSLD)

**Status:** Done

Implemented (commit `8362106`):
- ✅ OBF daily delta sync (`/api/cron/obf-delta`, schedule: `0 3 * * *`)
- ✅ DSLD weekly supplement sync (`/api/cron/dsld-sync`, schedule: `0 5 * * 0`)
- ✅ Grooming seed script (`scripts/seed-grooming.ts`) — ~200 top men's grooming brands
- ✅ `cronState` table tracking last processed state
- ✅ Batch upsert logic with idempotency
- ✅ Cron request auth verification

Code locations:
- Cron routes: `app/api/cron/obf-delta/route.ts`, `app/api/cron/dsld-sync/route.ts`
- Cron auth: `lib/cron/auth.ts`
- Ingest helpers: `lib/cron/ingest-helpers.ts` — `upsertProduct()`, `fetchGzipJsonl()`
- Seed script: `scripts/seed-grooming.ts`
- Config: `vercel.json` — cron schedule + timeout (300s for cron routes)

---

### ✅ M2.5 — Recommendations Backing API

**Status:** Done

Implemented (commit `8362106`):
- ✅ Subcategory inference in all normalization paths
- ✅ `scanEvents` table tracks user scan history
- ✅ `GET /api/recommendations` — returns user's Poor/Mediocre products with better alternatives
- ✅ `GET /api/products/:id/alternatives` — same-subcategory products scoring 15+ points higher
- ✅ Inline alternatives fetched in scan result (top 3)
- ✅ Subcategory + score index for fast alternatives query

Code locations:
- Subcategory inference: `lib/subcategory.ts`
- Recommendations endpoint: `app/api/recommendations/route.ts`
- Alternatives endpoint: `app/api/products/[id]/alternatives/route.ts`
- Scan event tracking: `app/api/products/scan/[barcode]/route.ts` (lines 192–204, 356–427)
- DB index: `db/schema.ts` — `products_subcategory_score_idx`

---

## Pending Milestones

### 📋 M3 — User Submissions + OCR Pipeline

**Status:** Planning complete, ready for implementation

**Documentation:** [M3-USER-SUBMISSIONS.md](./M3-USER-SUBMISSIONS.md)

**What:** User can submit front + back photos of unknown products. Backend validates and publishes to catalog.

**Three-phase strategy:**

#### **M3.0 (Week 2–3) — Simple Submission + Manual Review**
- **Scope:** User submission UI (two-photo flow) + admin review dashboard
- **Tech:** No OCR; manual ingredient extraction by admin
- **Timeline:** 4–6 hours backend, 2–3 hours Expo client
- **Files to create:**
  - `app/api/products/submit/route.ts` — accept barcode + photos
  - `app/api/admin/submissions/route.ts` — list pending
  - `app/api/admin/submissions/[id]/publish/route.ts` — publish product
  - `app/(tabs)/scan/(submission)/submit-product.tsx` — two-photo capture
- **Files to modify:**
  - `app/(tabs)/scan/result-sheet.tsx` — add "Submit product" CTA for `not_found`
- **User latency:** 24–48 hours (admin review)
- **Cost:** $0 (admin time only)

#### **M3.1 (Week 4–5) — Auto-OCR with Claude Vision**
- **Why Claude over Google Vision:** Better contextual understanding, confidence scoring, lower cost at MVP scale ($0.15–0.30/submission vs. $0.12 + manual cleanup)
- **Scope:** Integrate Claude vision to extract ingredients from back photo; auto-publish if confidence >= 85%
- **Timeline:** 6–8 hours
- **Files to create:**
  - `lib/ocr/claude-vision.ts` — Claude vision integration
- **Files to modify:**
  - `app/api/products/submit/route.ts` — integrate OCR + auto-publish logic
  - `app/api/admin/submissions/route.ts` — separate pending vs. auto-published queues
- **User latency:** <1 hour (auto-publish) + 24h for manual review of low-confidence
- **Cost:** ~$15–30/week (at 50–100 submissions/week)

#### **M3.2 (Month 2+) — Crowdsourced Quality Control**
- **Scope:** Community voting on submissions; admin spot-checks disputed entries
- **Timeline:** Ongoing (not blocking MVP)
- **Files to create:**
  - `db/schema.ts` — add `submissionVotes` table
  - `app/api/admin/submissions/votes/route.ts` — voting API
  - `app/admin/dashboard.tsx` — audit metrics

**Why phased approach:**
1. M3.0 validates UX before engineering OCR
2. By M3.1, you have 50–100 real submission examples to test OCR against
3. No bad product data published during MVP ramp-up
4. Admin bottleneck is minimal (spot-checking, not full review)

**Critical decision:** User submission flow is guided (front photo + back photo), not ad-hoc. See [M3-USER-SUBMISSIONS.md](./M3-USER-SUBMISSIONS.md) for full UX flow + justification.

---

### 📋 M4 — Search Endpoint

**Status:** Stub only (returns empty results)

**What:** `POST /api/products/search` with full-text + filters

**Current state:**
- File exists: `app/api/products/search/route.ts` (returns `{ data: [], total: 0 }`)
- Requires:** M2 seeding complete (need product catalog in DB)

**Scope (estimated 6–8 hours):**
- Full-text search: `name`, `brand`, `rawIngredients`
- Filters: `category`, `score` range, `subcategory`
- Cursor pagination: `limit` + `offset`
- Indexes: Product queries should use existing `products_category_score_idx` and `products_subcategory_score_idx`

**Blocker:** Needs baseline product catalog. OBF daily delta + grooming seed should provide 500+ products.

---

### 📋 M5 — Commercial Fallback

**Status:** Not started (low priority)

**What:** Fallback barcode lookup after OBF/DSLD miss (e.g., Nutritionix for food)

**Decision:** Skip for MVP unless user research shows "Unknown Product" label causes significant drop-off. Improves UX (show real product name instead of "Unknown Product") but cannot enable scoring without ingredients.

---

### 📋 M6 — User Submissions (Extended)

**Status:** Not started (QoL, not MVP-blocking)

**What:** Admin tooling improvements, batch processing, quality metrics (rolled into M3.2)

---

## Database Schema Status

**Exists and ready:**

```sql
products              — Main product catalog
product_ingredients   — Persisted ingredient lists
ingredient_dictionary — ~300 curated ingredients with flags
user_submissions      — User-submitted photos + OCR text
cronState             — Cron ingest progress tracking
scanEvents            — User scan history for recommendations
```

**Indexes present:**
- `products_category_score_idx` — for score filtering
- `products_subcategory_score_idx` — for alternatives lookup (with WHERE subcategory IS NOT NULL)
- `scan_events_user_product_idx` — for recommendations query
- `scan_events_user_scanned_at_idx` — for history + most recent first

**RLS policies:** Implemented for authenticated user access + service_role admin access

---

## Environment Variables

### Required (M1+)
```
SUPABASE_JWT_SECRET     — [TODO] Get from Supabase Settings → API → JWT Settings
OFF_USER_AGENT          — [DONE] Set in Vercel env
```

### Optional (M3.1+)
```
ANTHROPIC_API_KEY       — [TODO] Claude vision integration (M3.1)
S3_BUCKET_NAME          — [TODO] Photo storage (M3.0)
S3_ACCESS_KEY_ID        — [TODO] Photo storage (M3.0)
S3_SECRET_ACCESS_KEY    — [TODO] Photo storage (M3.0)
```

---

## Quick Reference: What to Do Next

### Immediate (Before MVP Launch)

1. **M1 hardening (1 hour)**
   - [ ] Add `SUPABASE_JWT_SECRET` to Vercel
   - [ ] Verify auth flow works

2. **M3.0 — Simple Submission (4–6 hours backend, 2–3 hours Expo)**
   - [ ] Implement `POST /api/products/submit`
   - [ ] Add admin review endpoints
   - [ ] Add two-photo capture UI in Expo
   - [ ] Add "Submit product" CTA to `not_found` state
   - [ ] Manual review workflow (admin lists pending → reviews photos → publishes)

3. **Run grooming seed (1 hour)**
   - [ ] `npx tsx scripts/seed-grooming.ts` (if not already run)
   - [ ] Verify ~200 products in DB

4. **M4 — Search Endpoint (6–8 hours)**
   - [ ] Implement full-text + filtered search
   - [ ] Test with seeded products
   - [ ] Wire up to Expo search tab

### After MVP Launch

5. **M3.1 — Auto-OCR (6–8 hours)**
   - [ ] Integrate Claude vision
   - [ ] Auto-publish if confidence >= 85%
   - [ ] Admin spot-check workflow

6. **M3.2 — Community Quality Control**
   - [ ] Voting endpoint
   - [ ] Metrics dashboard

7. **M5 — Commercial Fallback (if needed)**
   - [ ] Evaluate based on user feedback

---

## Known Limitations & Notes

1. **DSLD has no barcode endpoint:** Supplements only resolve from DB cache (populated by M2 weekly sync). At scan time, unknown supplement barcodes return 404.

2. **Grooming catalog growth:** OBF + manual seed gets you to ~60–70% hit rate. User submissions (M3) fill the remaining 30–40% gap.

3. **Nutri-Score disabled for non-food:** Scan route correctly strips Nutri-Score for grooming/supplement products (line 262–264 in scan route).

4. **Inline alternatives only if DB configured:** If Supabase is down, scan still works (returns product + score without alternatives).

5. **Recommendation accuracy depends on subcategory inference:** Mismatch in subcategory logic between backend + Expo client could cause strange alternative recommendations. Keep them in sync.

---

## Testing Checklist

- [ ] M1: Scan a known OFF barcode (e.g., `3017620422003` Nutella) → returns scored product
- [ ] M1.5: Scan a known OBF barcode (grooming) → returns category `'grooming'` with proper ingredient flags
- [ ] M2: OBF delta cron runs daily → products appear in DB
- [ ] M2: DSLD sync runs weekly → supplement products appear in DB
- [ ] M2.5: Scan a Poor product → alternatives endpoint returns products 15+ points higher
- [ ] M2.5: After scanning, recommendations endpoint returns user's Poor scans with alternatives
- [ ] M3.0: User submits front + back photos → saves to `userSubmissions` table
- [ ] M3.0: Admin publishes submission → creates product in DB and cache
- [ ] M3.0: Scan same barcode again → returns published product (cache hit, no upstream call)
- [ ] M3.1 (future): Claude OCR extracts ingredients with >85% confidence
- [ ] M4: Full-text search returns products matching query + filters

---

## References

- [ROADMAP.md](./ROADMAP.md) — High-level milestone overview
- [M1.5-MULTI-SOURCE-SCANNING.md](./M1.5-MULTI-SOURCE-SCANNING.md) — Multi-source architecture details
- [M2-CRON-INGEST.md](./M2-CRON-INGEST.md) — Cron ingest implementation
- [M2.5-RECOMMENDATIONS-API.md](./M2.5-RECOMMENDATIONS-API.md) — Recommendations backing API
- [M3-USER-SUBMISSIONS.md](./M3-USER-SUBMISSIONS.md) — **NEW:** Phased user submissions strategy
- [DATABASE-CHARTER.md](./DATABASE-CHARTER.md) — Schema + data consistency rules
- [DATA-FETCH-SOP.md](./DATA-FETCH-SOP.md) — Source API details (OFF, OBF, DSLD)

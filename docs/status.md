# GuardScan API — Implementation Status

**Last updated:** 2026-04-11
**Current focus:** MVP sprint (M4 search, auth hardening, catalog densification)

For task-level detail and sequencing, see [docs/mvp-sprint-plan.md](./mvp-sprint-plan.md) — that document is the authoritative source of truth for this sprint.

---

## Executive Summary

**Shipped:** M1, M1.5, M2, M2.5, M3.0, M3.1
**In progress:** MVP sprint (search, auth flip, catalog densification)
**Blocked:** Nothing — all blockers resolved
**Deferred:** M3.2 (on-device auto-crop), M5 (commercial fallback), Pomenatal multi-brand

---

## Milestone Status

### ✅ M1 — Schema + Scan via OFF

**Status:** Done

- `GET /api/products/scan/:barcode` returns scored products from OFF
- Supabase Postgres connected (US East, transaction pooler)
- DB schema applied: `products`, `product_ingredients`, `ingredient_dictionary`, `user_submissions`, `cronState`, `scanEvents`
- Background cache writes via Next.js `after()` callback
- CORS proxy for Expo Web / browser clients
- Deployed on Vercel Fluid Compute (region `iad1`)

---

### ✅ M1.5 — Multi-Source Scanning + Dictionary Growth

**Status:** Done

- OBF (Open Beauty Facts) adapter for grooming products
- DSLD (NIH Dietary Supplement Label Database) adapter for supplements
- Parallel OFF + OBF lookup (first non-null wins)
- Subcategory inference (`lib/subcategory.ts`)
- Dictionary expanded to ~147 curated entries
- Ingredient normalization for OBF + DSLD products
- Scan route prioritizes OBF when OFF detects grooming category

Code locations:
- Sources: `lib/sources/openbeautyfacts.ts`, `lib/sources/dsld.ts`
- Normalization: `lib/normalize.ts`
- Dictionary: `lib/dictionary/seed.ts`
- Scan route: `app/api/products/scan/[barcode]/route.ts`

---

### ✅ M2 — Cron Ingest (OBF + DSLD)

**Status:** Done

- OBF daily delta sync (`/api/cron/obf-delta`, schedule: `0 3 * * *`)
- DSLD weekly supplement sync (`/api/cron/dsld-sync`, schedule: `0 5 * * 0`)
- Grooming seed script (`scripts/seed-grooming.ts`)
- `cronState` table tracking last processed state
- Batch upsert logic with idempotency
- Cron request auth verification

Code locations:
- Cron routes: `app/api/cron/obf-delta/route.ts`, `app/api/cron/dsld-sync/route.ts`
- Ingest helpers: `lib/cron/ingest-helpers.ts` — `upsertProduct()`, `fetchGzipJsonl()`
- Config: `vercel.json` — cron schedule + timeout (300s for cron routes)

---

### ✅ M2.5 — Recommendations Backing API

**Status:** Done

- `scanEvents` table tracks user scan history
- `GET /api/recommendations` — returns user's Poor/Mediocre products with better alternatives
- `GET /api/products/:id/alternatives` — same-subcategory products scoring 15+ points higher
- Inline alternatives fetched in scan result (top 3)
- Subcategory + score index for fast alternatives query

Code locations:
- Recommendations endpoint: `app/api/recommendations/route.ts`
- Alternatives endpoint: `app/api/products/[id]/alternatives/route.ts`
- DB index: `db/schema.ts` — `products_subcategory_score_idx`

---

### ✅ M3.0 — User Submissions + Manual Review

**Status:** Done

- `POST /api/products/submit` — accept barcode + photos
- `app/api/admin/submissions/` — list and manage pending submissions
- Admin CLI (`scripts/admin-submissions.ts`) — list, review, publish, reject
- Photos stored in Supabase Storage (`submissions` bucket, private)
- Signed photo URLs in admin review flow

---

### ✅ M3.1 — Auto-OCR with Claude Vision

**Status:** Done

- Claude Vision integration via OpenRouter (`lib/ocr/claude-vision.ts`)
- Auto-publish when confidence ≥ 85 (`AUTO_PUBLISH_CONFIDENCE_THRESHOLD`)
- Kill switch: `AUTO_PUBLISH_ENABLED=false` bypasses auto-publish immediately
- Guardrails: minimum ingredient count, barcode sanity, plausibility checks
- 8 pending submissions in queue awaiting Task 0 disposition

Code locations:
- OCR: `lib/ocr/claude-vision.ts`
- Auto-publish: `lib/submissions/auto-publish.ts`
- Submit route: `app/api/products/submit/route.ts`

---

## Current State (verified 2026-04-11)

| Signal | Value |
|---|---|
| Total products | 1,417 |
| Products with score | 415 (29%) |
| Products with ingredients | 1,015 (72%) |
| Products missing subcategory | 366 (26%) |
| Dictionary entries | 147 |
| Pending user submissions | 8 |

---

## In-Progress / Pending Milestones

### 🔄 M4 — Search Endpoint

**Status:** Stub replaced with real implementation (Task 6 in sprint)

- `POST /api/products/search` — full-text + filtered + sorted search
- `GET /api/products/search/suggestions` — autocomplete (Task 8)
- Response: `PaginatedResponse<Product>`

---

### 📋 M5 — Commercial Fallback

**Status:** Deferred (not MVP-blocking)

- Fallback barcode lookup after OBF/DSLD miss (e.g., Nutritionix for food)
- Revisit if "Unknown Product" causes measurable drop-off

---

## Database Schema Status

```sql
products              — Main product catalog
product_ingredients   — Persisted ingredient lists
ingredient_dictionary — ~147 curated ingredients with flags
user_submissions      — User-submitted photos + OCR text (field: reviewed_by added in M3.0)
cronState             — Cron ingest progress tracking
scanEvents            — User scan history for recommendations
```

**Indexes:**
- `products_category_score_idx` — score filtering by category
- `products_subcategory_score_idx` — alternatives lookup (WHERE subcategory IS NOT NULL)
- `scan_events_user_product_idx` — recommendations query
- `scan_events_user_scanned_at_idx` — history + most recent first

---

## Environment Variables

### Required (all environments)

```
DATABASE_URL                — Supabase Postgres Transaction pooler (port 6543)
OFF_USER_AGENT              — "GuardScan/1.0 (your@email.com)"
SUPABASE_URL                — Supabase project URL
SUPABASE_SERVICE_ROLE_KEY   — Supabase service role key (for storage + admin ops)
SUPABASE_JWT_SECRET         — JWT Secret from Supabase Settings → API (for Bearer token verification)
AUTH_ENABLED                — "true" in production/preview; "false" in local dev (.env)
OPENROUTER_API_KEY          — Claude Vision via OpenRouter (M3.1 OCR)
CRON_SECRET                 — Secret for cron route authentication
```

### Optional

```
AUTO_PUBLISH_ENABLED        — "false" to disable auto-publish kill switch (default: enabled)
ALLOW_DEV_AUTH              — "true" to accept X-Dev-User-Id header (local dev only, never production)
ADMIN_USER_IDS              — Comma-separated Supabase user IDs with admin access
LOG_LEVEL                   — debug|info|warn|error (default: info)
PROVIDER_FALLBACK_ENABLED   — "true" for commercial fallback (M5, deferred)
PROVIDER_API_KEY            — Commercial provider API key (M5, deferred)
```

---

## What to Do Next

See [docs/mvp-sprint-plan.md](./mvp-sprint-plan.md) for the full task breakdown.

**Immediate priorities (this sprint):**
1. **Task 0** — Disposition the 8 pending user submissions
2. **Task 1** — Preview deploy + kill switch + e2e
3. **Task 2** — Rescore + subcategory backfill (both phases — mandatory for 90% coverage)
4. **Task 3** — Manual QA of M2.5 recommendations against dense pool
5. **Task 4** — Enable JWT auth in production (auth is live; verify no 401 spike)
6. **Task 6** — Search POST endpoint (stub → real implementation)
7. **Task 8** — Search suggestions endpoint (currently 404)

**One remaining manual step for Task 4:**
Run this in an interactive terminal to add `AUTH_ENABLED` to Preview:
```bash
vercel env add AUTH_ENABLED preview
# Enter: true
```

---

## Known Limitations

1. **DSLD has no barcode endpoint:** Supplements only resolve from DB cache (populated by M2 weekly sync). Unknown supplement barcodes return 404 at scan time.
2. **Grooming catalog coverage:** OBF + manual seed gets ~60–70% hit rate. User submissions (M3) fill the remainder.
3. **Nutri-Score disabled for non-food:** Correctly stripped for grooming/supplement products.
4. **Alternatives accuracy depends on subcategory:** Keep backend and Expo client subcategory logic in sync.
5. **Catalog is sparse (29% scored):** Task 2 rescore + backfill brings this to ~90%.

---

## References

- [docs/mvp-sprint-plan.md](./mvp-sprint-plan.md) — **authoritative sprint plan** (source of truth)
- [docs/roadmap.md](./roadmap.md) — Milestone-level goals
- [CLAUDE.md](../CLAUDE.md) — Codebase conventions
- [docs/milestones/m3-user-submissions.md](./milestones/m3-user-submissions.md) — M3.0/M3.1 pipeline detail

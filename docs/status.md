# GuardScan API — Status

**Last updated:** 2026-05-13
**Production:** https://guardscan-api.vercel.app (Vercel, region `iad1`)

---

## Catalog Snapshot

| Signal | Value |
|---|---|
| Total products | 2,356 |
| Scored | 1,224 (52%) |
| With ingredients | 2,350 (99.7%) — 46,492 ingredient rows, avg 19.8/product |
| Missing subcategory | 410 |
| Dictionary entries | 147 (all enriched with groups + risk tags) |
| Pending user submissions | 20 |
| Published user submissions | 41 |
| Foreign-named rows (pre-backfill) | ~223 (9.5%) — Phase 3 of translation backfill clears these |

### By Category

| Category | Products | Notes |
|---|---|---|
| Grooming | 1,216 | Primary MVP focus. OBF + user submissions drive coverage. |
| Supplement | 1,128 | DSLD-sourced; scoring deferred — see Known Limitations. |
| Food | 12 | Minimal; not a focus. |

### By Source

| Source | Products |
|---|---|
| OBF | 1,178 |
| DSLD | 1,127 |
| User submissions | 41 |
| OFF | 10 |

---

## Shipped Milestones

### M1 — Schema + Scan via OFF

- `GET /api/products/scan/:barcode` returns scored products from OFF
- Supabase Postgres (US East, transaction pooler)
- DB schema: `products`, `product_ingredients`, `ingredient_dictionary`, `user_submissions`, `cronState`, `scanEvents`
- Background cache writes via Next.js `after()`
- CORS proxy for Expo Web / browser clients
- Deployed on Vercel Fluid Compute

### M1.5 — Multi-Source Scanning + Dictionary

- OBF (Open Beauty Facts) adapter for grooming
- DSLD (NIH Dietary Supplement Label Database) adapter for supplements
- Parallel OFF + OBF lookup (first non-null wins)
- Subcategory inference (`lib/subcategory.ts`)
- 147 curated dictionary entries with flags, evidence URLs, fertility/testosterone relevance

### M2 — Cron Ingest

- OBF daily delta sync (`/api/cron/obf-delta`, schedule: `0 3 * * *`)
- DSLD weekly supplement sync (`/api/cron/dsld-sync`, schedule: `0 5 * * 0`)
- `cronState` table tracking last processed state
- Batch upsert with idempotency

### M2.5 — Recommendations + Alternatives

- `scanEvents` table tracks user scan history
- `GET /api/recommendations` — user's Poor/Mediocre products paired with better alternatives
- `GET /api/products/:id/alternatives` — same-subcategory products scoring 15+ points higher
- Top 3 alternatives inlined in scan results

### M3.0 — User Submissions + Manual Review

- `POST /api/products/submit` — accept barcode + front/back photos
- Admin CLI (`scripts/admin-submissions.ts`) — list, inspect, publish, review, reject
- Photos stored in Supabase Storage (`submissions` bucket, private)
- Signed photo URLs in review flows

### M3.1 — Auto-OCR with Claude Vision

- Claude Vision integration via OpenRouter (`lib/ocr/claude-vision.ts`)
- Auto-publish when confidence >= 90 (`AUTO_PUBLISH_CONFIDENCE_THRESHOLD`)
- Kill switch: `AUTO_PUBLISH_ENABLED=false` bypasses auto-publish
- Guardrails: minimum ingredient count, barcode sanity, plausibility checks

### M3.2 — Admin Web Dashboard

- Web UI at `/api/admin/submissions` for reviewing pending submissions
- Individual submission detail, publish, and reject routes
- Replaces CLI-only workflow for routine triage

### M4 — Shelf

- `shelf_items` table — manual user-curated product collection with swap tracking
- Denormalized product snapshot (name, brand, category, score) refreshed on rescore
- Scan-date bump on every scan if product is on user's shelf

### Translation Backfill — Phases 1 + 2 (2026-05-13)

- **Phase 1 (commit `ea9c2a5`):** migration `0008_translation_columns` adds
  `original_name`, `source_language`, `translation_status` to `products`.
  Schema columns claim a row for the translation pipeline so the daily OBF
  cron stops clobbering English names with upstream foreign re-emits.
- **Phase 2 (commit `d1fa784`):** synchronous LLM translation at intake.
  `lib/translation.ts` provides `looksForeign()` (heuristic with English-
  loanword allowlist: maté, naïve, açaí, kombucha, kefir, yerba, café) and
  `translateProductName()` (OpenRouter, 5s timeout, never throws).
  `lib/cron/ingest-helpers.ts:resolveClaim` decision tree:
  - `manual` → never touch claim fields
  - `auto|pending|failed|disputed` → preserve our name, refresh original
  - no claim + foreign → translate sync, status=`auto` or `failed`
  - no claim + foreign + no API key → status=`pending` (outbox-eligible)
  Scan route refactored to call `upsertProduct` so it can't bypass the claim.
  Round-trip test: `npm run test:translation` (30/30 passing).
- **Phase 3 (pending):** one-shot backfill of the existing 223 foreign rows.
  Plan documented in [proposals/translation-backfill.md](./proposals/translation-backfill.md).

### Scoring v1.2.0 — Subtract-Only

- Positive flags no longer contribute to the numeric score (was +5/+3/+2, now 0/0/0)
- Negative and caution deductions unchanged
- 442 products rescored via `scripts/rescore-v1.2.ts`
- Rationale: [architecture/scoring-v1.2-subtract-only-report.md](./architecture/scoring-v1.2-subtract-only-report.md)

### Ingredient Enrichment (Phase 1 + Phase 2)

- All 147 dictionary entries enriched with `ingredient_group` and `health_risk_tags`
- PubChem CID validation for evidence URLs
- `GET /api/ingredients/:normalized` — detail endpoint for ingredient tap-through
- Migration: `0004_ingredient_enrichment.sql`
- Proposal: [post-mvp/ingredient-enrichment.md](./post-mvp/ingredient-enrichment.md)

### Score Calibration

- `GET /api/admin/calibration` — calibration page for grooming category
- Protocol: [architecture/scoring-calibration-protocol.md](./architecture/scoring-calibration-protocol.md)

### Image Resolution + Backfill

- Product images resolved from OBF/OFF source URLs
- Backfill script for missing `image_front` values

### Expo Client (cucumberdude)

- RevenueCat subscription + freemium gating (2 free scans/day, 5 guest total)
- Guest mode with Supabase anonymous auth
- Ingredient detail modal with risk tags + collapse toggle for risk-free ingredients
- Pending score UI for null-scored products ("Score coming soon" badge)
- Product detail page redesign with fertility-awareness indicators
- Tab reordering (scan centered)
- Camera autofocus + tilt quality indicator
- Substring autocomplete in search suggestions

---

## API Endpoints

| Method | Route | Purpose |
|---|---|---|
| GET | `/api/health` | Health check |
| GET | `/api/products/scan/:barcode` | Scan + score a product |
| GET | `/api/products/:id` | Product detail |
| GET | `/api/products/:id/score` | Score breakdown |
| GET | `/api/products/:id/alternatives` | Same-subcategory alternatives |
| POST | `/api/products/search` | Full-text + filtered search |
| GET | `/api/products/search/suggestions` | Autocomplete (substring match) |
| POST | `/api/products/submit` | User submission (photos + barcode) |
| GET | `/api/ingredients/:normalized` | Enriched ingredient detail |
| GET | `/api/recommendations` | Personalized recommendation pairs |
| GET | `/api/profiles/me` | User profile |
| PUT | `/api/profiles/me` | Update profile |
| GET | `/api/profiles/me/subscription` | Subscription status |
| POST | `/api/profiles/me/subscription` | Update subscription tier after purchase |
| GET | `/api/profiles/me/history` | Scan history |
| GET | `/api/profiles/me/favorites` | Favorite products |
| POST | `/api/profiles/me/favorites/:productId` | Toggle favorite |
| POST | `/api/push/register` | Register push token |
| GET | `/api/admin/submissions` | List pending submissions (admin) |
| GET | `/api/admin/submissions/:id` | Submission detail (admin) |
| POST | `/api/admin/submissions/:id/publish` | Publish submission (admin) |
| POST | `/api/admin/submissions/:id/reject` | Reject submission (admin) |
| GET | `/api/admin/calibration` | Score calibration (admin) |
| GET | `/api/cron/obf-delta` | OBF daily sync (cron) |
| GET | `/api/cron/dsld-sync` | DSLD weekly sync (cron) |

---

## Database Schema

```
products              — Main product catalog (2,356 rows; translation columns
                        added in 0008 — original_name, source_language,
                        translation_status)
product_ingredients   — Ingredient lists per product (46,492 rows)
ingredient_dictionary — 147 curated entries with flags, groups, risk tags
user_submissions      — User-submitted photos + OCR text
cron_state            — Cron ingest progress tracking
scan_events           — User scan history for recommendations
shelf_items           — User-curated product collection (M4)
profiles              — User profile (life_stage, age, takes_supplements,
                        onboarding state)
```

**Migrations:** `0000_initial_tables` → `0001_cron_scan_events` →
`0002_policies` → `0003_m3_tweaks` → `0004_ingredient_enrichment` →
`0005_profiles` → `0006_shelf_items` → `0007_profiles_trim` →
`0008_translation_columns` (2026-05-13)

**Indexes:**
- `products_category_score_idx` — score filtering by category
- `products_subcategory_score_idx` — alternatives lookup
- `products_translation_status_idx` — partial, drives translation outbox
  scans and disputed-row reviews (only rows with non-NULL status indexed)
- `scan_events_user_product_idx` — recommendations query
- `scan_events_user_scanned_at_idx` — history (most recent first)
- `shelf_items_user_scan_date_idx`, `shelf_items_user_category_idx`

---

## Environment Variables

### Required

```
DATABASE_URL                — Supabase Postgres Transaction pooler (port 6543)
OFF_USER_AGENT              — "GuardScan/1.0 (your@email.com)"
SUPABASE_URL                — Supabase project URL
SUPABASE_SERVICE_ROLE_KEY   — Supabase service role key (storage + admin ops)
SUPABASE_JWT_SECRET         — JWT secret for Bearer token verification
AUTH_ENABLED                — "true" in production/preview
OPENROUTER_API_KEY          — Claude Vision via OpenRouter (OCR)
CRON_SECRET                 — Secret for cron route authentication
```

### Optional

```
AUTO_PUBLISH_ENABLED        — "false" to disable auto-publish (default: enabled)
ALLOW_DEV_AUTH              — "true" to accept X-Dev-User-Id header (local dev only)
ADMIN_USER_IDS              — Comma-separated Supabase user IDs with admin access
LOG_LEVEL                   — debug|info|warn|error (default: info)
OPENROUTER_TRANSLATOR_MODEL — Translation model override (defaults to
                              OPENROUTER_MODEL or google/gemma-4-26b-a4b-it)
OPENROUTER_CLASSIFIER_MODEL — Subcategory classifier model override
```

---

## Deferred

| Feature | Doc | Notes |
|---|---|---|
| Supplement scoring | [post-mvp/supplement-scoring.md](./post-mvp/supplement-scoring.md) | Needs quality/testing signals (DSLD doesn't provide). 688 supplements in catalog, 0 scored. |
| Ingredient enrichment Phase 3 | [post-mvp/ingredient-enrichment.md](./post-mvp/ingredient-enrichment.md) | Consumer-facing descriptions (3-4 paragraphs per ingredient). Phase 1+2 shipped. |
| Commercial fallback (M5) | — | Fallback barcode lookup (e.g. Nutritionix). Revisit if unknown-barcode drop-off is measurable. |
| Pomenatal brand onboarding | [multi-brand-migration.md](./multi-brand-migration.md) | White-label markers already in cucumberdude code. |

---

## Known Limitations

1. **Supplements are cataloged but unscored.** 1,128 supplements exist (via DSLD sync) but return `score: null`. The Expo client shows "Score coming soon."
2. **DSLD has no barcode endpoint.** Supplements only resolve from DB cache. Unknown supplement barcodes go through the user-submission flow.
3. **Grooming coverage depends on OBF + submissions.** OBF daily sync + user submissions fill gaps organically.
4. **Alternatives accuracy depends on subcategory.** 410 products still missing subcategory.
5. **Search excludes null-scored products.** Supplements don't appear in search results. Scan still returns them.
6. **~223 foreign-named rows pending backfill.** Translation Phase 1+2 are
   live, so new ingest is handled. Existing rows still display foreign names
   until Phase 3 backfill runs — see
   [proposals/translation-backfill.md](./proposals/translation-backfill.md).
7. **DSLD sync is partial.** Last successful run 2026-05-10; subsequent
   attempts marked `partial`. Worth investigating before next supplement
   coverage milestone.

---

## References

- [../CLAUDE.md](../CLAUDE.md) — codebase conventions
- [architecture/scoring.md](./architecture/scoring.md) — scoring methodology (v1.2.0)
- [architecture/scoring-v1.2-subtract-only-report.md](./architecture/scoring-v1.2-subtract-only-report.md) — v1.2.0 investigation report
- [architecture/security.md](./architecture/security.md) — security audit trail
- [api/endpoints.md](./api/endpoints.md) — detailed endpoint reference
- [testing/submission-flow-production.md](./testing/submission-flow-production.md) — submission e2e runbook
- [ocr-confidence-tuning.md](./ocr-confidence-tuning.md) — OCR threshold analysis
- [proposals/translation-backfill.md](./proposals/translation-backfill.md) — living proposal for foreign-name backfill (Phase 3 pending)
- [proposals/translation-callers-audit.md](./proposals/translation-callers-audit.md) — Phase 1 caller audit for translation

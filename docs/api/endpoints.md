# Backend API Endpoints

All routes are served from `https://guardscan-api.vercel.app`. Production requires `Authorization: Bearer <supabase_jwt>`. Local dev may use `X-Dev-User-Id: <id>` only if `ALLOW_DEV_AUTH=true` is set. Every `/api/*` route is rate-limited in [`proxy.ts`](../../proxy.ts) (tighter caps on scan). CORS allows `GET, POST, PUT, OPTIONS` from any origin.

Route source lives under [`app/api/`](../../app/api).

---

## Scan & products

| Method | Path | Handler | Returns |
|---|---|---|---|
| GET | `/api/products/scan/:barcode` | [scan/[barcode]/route.ts](../../app/api/products/scan/%5Bbarcode%5D/route.ts) | `ScanResult` — DB cache hit or OFF/OBF/DSLD lookup, scored, with inline top alternatives. Returns `404 { capture: true }` on unknown barcodes so the client can trigger the submission flow. |
| GET | `/api/products/:id` | [[id]/route.ts](../../app/api/products/%5Bid%5D/route.ts) | Product detail (with persisted ingredients). Accepts UUID or synthetic id (`off:...`, `obf:...`, `dsld:...`). |
| GET | `/api/products/:id/alternatives` | [[id]/alternatives/route.ts](../../app/api/products/%5Bid%5D/alternatives/route.ts) | `ProductAlternative[]` — same-subcategory products scoring ≥15 points higher. |
| GET | `/api/products/:id/score` | [[id]/score/route.ts](../../app/api/products/%5Bid%5D/score/route.ts) | **Stub** — returns `501 not_implemented`. Personalized score recomputation is currently inlined into the scan endpoint via `?life_stage=`. |

## Search

| Method | Path | Handler | Returns |
|---|---|---|---|
| POST | `/api/products/search` | [search/route.ts](../../app/api/products/search/route.ts) | `PaginatedResponse<Product>` — ILIKE + filters + sort (`relevance` \| `best_rated`). Excludes null-scored rows. |
| GET | `/api/products/search/suggestions` | [search/suggestions/route.ts](../../app/api/products/search/suggestions/route.ts) | Autocomplete suggestions. Excludes null-scored rows. |

Supplement rows are intentionally excluded from search and suggestions for the MVP — they carry `score: null` until supplement scoring ships. See [../post-mvp/supplement-scoring.md](../post-mvp/supplement-scoring.md).

## Ingredients

| Method | Path | Handler | Returns |
|---|---|---|---|
| GET | `/api/ingredients/:normalized` | [ingredients/[normalized]/route.ts](../../app/api/ingredients/%5Bnormalized%5D/route.ts) | `IngredientDetail` — enrichment metadata (`ingredient_group`, `health_risk_tags`, long-form `description`, `evidence_url`) for one dictionary entry. The path param is the canonical `normalized` key from a prior scan; URL-decoded and looked up case-insensitively (aliases included). 404 for unknown ingredients. |

## Submissions (M3.0 / M3.1)

| Method | Path | Handler | Returns |
|---|---|---|---|
| POST | `/api/products/submit` | [submit/route.ts](../../app/api/products/submit/route.ts) | Accepts barcode + front/back photos. Uploads to Supabase Storage, pre-extracts via Claude Vision, and either auto-publishes (confidence ≥ threshold + guardrails) or queues for admin review. |

Kill switch: `AUTO_PUBLISH_ENABLED=false` forces every submission through admin review regardless of confidence.

## Recommendations

| Method | Path | Handler | Returns |
|---|---|---|---|
| GET | `/api/recommendations` | [recommendations/route.ts](../../app/api/recommendations/route.ts) | `RecommendationPair[]` — user's Poor/Mediocre scans paired with the best same-subcategory alternative. |

## Profile

| Method | Path | Handler | Returns |
|---|---|---|---|
| GET | `/api/profiles/me` | [profiles/me/route.ts](../../app/api/profiles/me/route.ts) | `UserProfile` |
| PUT | `/api/profiles/me` | same | Echoes merged profile |
| GET | `/api/profiles/me/subscription` | [profiles/me/subscription/route.ts](../../app/api/profiles/me/subscription/route.ts) | `SubscriptionStatus` — current tier (`free` \| `pro`) and expiry. Stub until RevenueCat validation ships. |
| POST | `/api/profiles/me/subscription` | same | Accept tier update from client after RevenueCat purchase. Body: `{ tier }`. Stub — echoes tier without verifying receipt. |
| GET | `/api/profiles/me/history` | [profiles/me/history/route.ts](../../app/api/profiles/me/history/route.ts) | `PaginatedResponse<ScanHistoryItem>` |
| GET | `/api/profiles/me/favorites` | [profiles/me/favorites/route.ts](../../app/api/profiles/me/favorites/route.ts) | Favorites list |
| POST | `/api/profiles/me/favorites/:productId` | [profiles/me/favorites/[productId]/route.ts](../../app/api/profiles/me/favorites/%5BproductId%5D/route.ts) | Toggle favorite |

## Scan quota (free-tier metering)

| Method | Path | Handler | Returns |
|---|---|---|---|
| GET | `/api/scans/daily-count` | [scans/daily-count/route.ts](../../app/api/scans/daily-count/route.ts) | `{ count, limit }` — authenticated user's lifetime scan count vs. `FREE_SCANS_TOTAL` (default 5). Despite the name, this is a *lifetime* counter, not a per-day rolling counter. |
| POST | `/api/scans/record` | [scans/record/route.ts](../../app/api/scans/record/route.ts) | `{ count, limit }` — atomically increments the user's lifetime scan count (creates the profile row on first call). |

## Admin (dev-only)

Every admin route returns `404 not_available` in production (`NODE_ENV === 'production'`). They additionally require `requireAdmin` — currently any authenticated user in non-production environments. These exist for the local moderation tooling and have no production surface yet.

| Method | Path | Handler | Returns |
|---|---|---|---|
| GET | `/api/admin/calibration` | [admin/calibration/route.ts](../../app/api/admin/calibration/route.ts) | Recently scored products with their flagged ingredients, used to calibrate the dictionary against real catalog data. Query: `category` (`food` \| `grooming` \| `supplement`, default `grooming`), `limit` (max 500, default 200). |
| GET | `/api/admin/submissions` | [admin/submissions/route.ts](../../app/api/admin/submissions/route.ts) | Paginated submission queue. Query: `status` (`pending` \| `in_review` \| `published` \| `rejected` \| `all`, default `pending`), `limit` (max 100), `offset`. |
| GET | `/api/admin/submissions/:id` | [admin/submissions/[id]/route.ts](../../app/api/admin/submissions/%5Bid%5D/route.ts) | Single submission detail — signed photo URLs, parsed OCR JSON, ingredient-flag preview, duplicate-barcode check. Optional `?preview_ingredients=a,b,c` to override the OCR-extracted list when previewing flag impact. |
| POST | `/api/admin/submissions/:id/publish` | [admin/submissions/[id]/publish/route.ts](../../app/api/admin/submissions/%5Bid%5D/publish/route.ts) | Publish a reviewed submission as a real product. Body: `{ name, brand?, category, ingredients[] }`. 409 if the submission is no longer in `pending` / `in_review`. |
| POST | `/api/admin/submissions/:id/reject` | [admin/submissions/[id]/reject/route.ts](../../app/api/admin/submissions/%5Bid%5D/reject/route.ts) | Mark a submission rejected. Body: `{ reason }`. 409 if already published. |

## Cron (Vercel-scheduled)

Both routes require `Authorization: Bearer <CRON_SECRET>` (Vercel sets this automatically on scheduled invocations) and run with `maxDuration: 300`. Schedules are defined in [`vercel.json`](../../vercel.json).

| Method | Path | Handler | Schedule |
|---|---|---|---|
| GET | `/api/cron/obf-delta` | [cron/obf-delta/route.ts](../../app/api/cron/obf-delta/route.ts) | `0 3 * * *` — Open Beauty Facts daily delta JSONL ingest |
| GET | `/api/cron/dsld-sync` | [cron/dsld-sync/route.ts](../../app/api/cron/dsld-sync/route.ts) | `0 5 * * 0` — DSLD weekly supplement sync |

## Infrastructure

| Method | Path | Handler | Returns |
|---|---|---|---|
| GET | `/api/health` | [health/route.ts](../../app/api/health/route.ts) | `{ status, service, version, timestamp }` — liveness check, exempt from auth and rate limiting. |
| POST | `/api/push/register` | [push/register/route.ts](../../app/api/push/register/route.ts) | Register a push token (stub — no backend side effects yet). |

---

## Shared types

All response shapes are defined in [`types/guardscan.ts`](../../types/guardscan.ts) and must mirror the Expo client. Relevant exports:

- `Product` / `ScanResult` / `ScoreBreakdown` / `AssessmentCoverage`
- `Ingredient` / `IngredientDetail` / `IngredientFlag`
- `ProductAlternative` / `RecommendationPair`
- `UserProfile` / `DietaryApproach` / `LifeStage` / `SubscriptionStatus` / `SubscriptionTier`
- `ScanHistoryItem`
- `SearchFilters` / `SearchSuggestion` / `SearchResultItem` / `PaginatedResponse<T>`
- `SubmissionResponse`

Breaking changes to any of these types require a coordinated change in [`cucumberdude`](../../../cucumberdude).

# Backend API Endpoints

All routes are served from `https://guardscan-api.vercel.app`. Production requires `Authorization: Bearer <supabase_jwt>`. Local dev may use `X-Dev-User-Id: <id>` only if `ALLOW_DEV_AUTH=true` is set. Every `/api/*` route is rate-limited in [`proxy.ts`](../../proxy.ts) (tighter caps on scan). CORS allows `GET, POST, PUT, OPTIONS` from any origin.

Route source lives under [`app/api/`](../../app/api).

---

## Scan & products

| Method | Path | Handler | Returns |
|---|---|---|---|
| GET | `/api/products/scan/:barcode` | [scan/[barcode]/route.ts](../../app/api/products/scan/%5Bbarcode%5D/route.ts) | `ScanResult` — DB cache hit or OFF/OBF/DSLD lookup, scored, with inline top alternatives. Returns `404 { capture: true }` on unknown barcodes so the client can trigger the submission flow. |
| GET | `/api/products/:id` | [[id]/route.ts](../../app/api/products/%5Bid%5D/route.ts) | Product detail (with persisted ingredients). |
| GET | `/api/products/:id/alternatives` | [[id]/alternatives/route.ts](../../app/api/products/%5Bid%5D/alternatives/route.ts) | `ProductAlternative[]` — same-subcategory products scoring ≥15 points higher. |
| GET | `/api/products/:id/score` | [[id]/score/route.ts](../../app/api/products/%5Bid%5D/score/route.ts) | Score breakdown detail. |

## Search

| Method | Path | Handler | Returns |
|---|---|---|---|
| POST | `/api/products/search` | [search/route.ts](../../app/api/products/search/route.ts) | `PaginatedResponse<Product>` — ILIKE + filters + sort (`relevance` \| `best_rated`). Excludes null-scored rows. |
| GET | `/api/products/search/suggestions` | [search/suggestions/route.ts](../../app/api/products/search/suggestions/route.ts) | Autocomplete suggestions. Excludes null-scored rows. |

Supplement rows are intentionally excluded from search and suggestions for the MVP — they carry `score: null` until supplement scoring ships. See [../post-mvp/supplement-scoring.md](../post-mvp/supplement-scoring.md).

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
| GET | `/api/profiles/me/history` | [profiles/me/history/route.ts](../../app/api/profiles/me/history/route.ts) | `PaginatedResponse<ScanHistoryItem>` |
| GET | `/api/profiles/me/favorites` | [profiles/me/favorites/route.ts](../../app/api/profiles/me/favorites/route.ts) | Favorites list |
| POST | `/api/profiles/me/favorites/:productId` | [profiles/me/favorites/[productId]/route.ts](../../app/api/profiles/me/favorites/%5BproductId%5D/route.ts) | Toggle favorite |

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

- `Product` / `ScanResult` / `ScoreBreakdown`
- `ProductAlternative` / `RecommendationPair`
- `UserProfile` / `DietaryApproach` / `LifeStage`
- `ScanHistoryItem`
- `SearchFilters` / `PaginatedResponse<T>`

Breaking changes to any of these types require a coordinated change in [`cucumberdude`](../../../cucumberdude).

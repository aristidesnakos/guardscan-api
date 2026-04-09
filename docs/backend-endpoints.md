# Backend API Endpoints

All routes are served from `https://guardscan-api.vercel.app`. Auth via `X-Dev-User-Id` header (dev) or `Authorization: Bearer <jwt>` (production). CORS allows `GET, POST, PUT, OPTIONS` from any origin.

## Live (M1)

| Method | Path | Returns |
|--------|------|---------|
| GET | `/api/health` | `{ status, service, version, timestamp }` |
| GET | `/api/products/scan/:barcode` | `ScanResult` — OFF lookup + scoring + DB cache write |

## Stubs (return valid JSON, no business logic yet)

| Method | Path | Response | Ships in |
|--------|------|----------|----------|
| GET | `/api/recommendations` | `[]` | M2.5 |
| GET | `/api/products/:id` | `501 { error: 'not_implemented' }` | M2.5 |
| GET | `/api/products/:id/alternatives` | `[]` | M2.5 |
| GET | `/api/products/:id/score` | `501 { error: 'not_implemented' }` | — |
| POST | `/api/products/search` | `{ data: [], total: 0, limit: 20, offset: 0 }` | M4 |
| GET | `/api/profiles/me` | Default `UserProfile` | — |
| PUT | `/api/profiles/me` | Echoes body merged with defaults | — |
| GET | `/api/profiles/me/history` | `{ data: [], total: 0, limit: 20, offset: 0 }` | — |
| GET | `/api/profiles/me/favorites` | `[]` | — |
| POST | `/api/profiles/me/favorites/:productId` | `{ is_favorite: false }` | — |
| POST | `/api/push/register` | `{ success: true }` | — |

## Why stubs exist

The Expo frontend expects all 12 endpoints. When `EXPO_PUBLIC_USE_MOCK_API=false`, every call goes to the real backend. Without stubs, unimplemented routes return Vercel's default 404 HTML page, which the app can't parse.

Stubs return the minimum valid JSON so the frontend renders empty states instead of crashing. As each milestone ships, the stub is replaced with real logic in the same route file — no frontend changes needed.

## Types added for stubs

Added to `types/guardscan.ts` to support the new routes:

- `DietaryApproach` — diet union type
- `UserProfile` — user health profile
- `ScanHistoryItem` — scan history entry
- `SearchFilters` — search request body
- `PaginatedResponse<T>` — paginated wrapper

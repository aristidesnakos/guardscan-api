# guardscan-api

Backend for the GuardScan mobile app. Next.js 16 on Vercel Fluid Compute, Postgres via Drizzle, Open Food Facts as the primary data source.

**Design contract:** [../cucumberdude/docs/PRODUCT-DATABASE-CHARTER.md](../cucumberdude/docs/PRODUCT-DATABASE-CHARTER.md). Do not change behavior that contradicts the charter without updating it first.

## Status

| Milestone | Status |
|---|---|
| M1 — Schema + `GET /api/products/scan/:barcode` via OFF | in progress |
| M2 — OBF + DSLD | pending |
| M2.5 — Recommendations backing API | pending |
| M3 — Search + ingredient dictionary | pending |
| M4 — Cron ingest | pending |
| M5 — Commercial fallback | pending |
| M6 — User submissions + OCR | pending |

## Quickstart

```bash
npm install
cp .env.example .env.local
# Fill in OFF_USER_AGENT at minimum. DATABASE_URL is optional in M1.
npm run dev
```

Then:

```bash
# Nutella — known-good OFF barcode
curl http://localhost:3000/api/products/scan/3017620422003 | jq

# Health check
curl http://localhost:3000/api/health
```

### Smoke test

```bash
npm run smoke

# Against a deployed URL:
API_URL=https://your-deployment.vercel.app npm run smoke
```

Runs `scripts/smoke.ts` and asserts a normalized `ScanResult` comes back for the Nutella barcode with an image URL and a computed score.

## Deployment

Deployed on Vercel Fluid Compute, US East (`iad1`). Database is Supabase Postgres (US East — N. Virginia), accessed via the Transaction pooler (port 6543).

### First deploy

```bash
npm i -g vercel
vercel link
vercel env add DATABASE_URL       # Supabase Transaction pooler URL (port 6543)
vercel env add OFF_USER_AGENT
vercel deploy --prod
```

### DB migrations

```bash
# Apply schema to Supabase (run once, or after schema changes)
npm run db:migrate
```

## Environment

| Var | Required | Purpose |
|---|---|---|
| `OFF_USER_AGENT` | yes | Open Food Facts requires a User-Agent. Format: `GuardScan/1.0 (contact@example.com)` |
| `DATABASE_URL` | no (M1) | Postgres connection string. When unset, the scan route skips the cache and hits OFF on every request. |
| `AUTH_ENABLED` | no | `true` to require auth. M1 dev default is unset (open). |
| `SUPABASE_JWT_SECRET` | M1.5 | For verifying Bearer tokens. Not used in M1. |
| `PROVIDER_FALLBACK_ENABLED` | no | M5 flag for Nutritionix fallback. Keep `false` in v1. |
| `LOG_LEVEL` | no | `debug` \| `info` \| `warn` \| `error`. Defaults to `info`. |

Manage in Vercel with `vercel env add`, pull locally with `vercel env pull .env.local`.

## Architecture

```
Expo app ──GET /api/products/scan/:barcode──▶  Vercel Function (Node.js runtime)
                                                    │
                                                    ▼
                                        ┌───────────────────────┐
                                        │ 1. DB cache (opt.)    │
                                        │ 2. fetchOffProduct()  │
                                        │ 3. normalizeOffProduct│
                                        │ 4. scoreProduct()     │
                                        │ 5. after() → cache    │
                                        └───────────────────────┘
                                                    │
                                                    ▼
                                       Supabase Postgres (US East)
                                        products, product_ingredients,
                                        ingredient_dictionary, user_submissions
```

- **Runtime:** Node.js on Fluid Compute. Not Edge (postgres.js + full Node API).
- **Scoring:** Pure function in `lib/scoring/`. Constants mirror the Expo app's `constants/Scoring.ts`. Any change must land in both in the same PR (see charter §13.4).
- **DB-optional in M1:** routes tolerate `DATABASE_URL` being unset. Once M3 ships the dictionary, the DB becomes mandatory.
- **CORS:** `proxy.ts` sets `Access-Control-Allow-Origin: *` on all `/api/*` responses, enabling Expo Web and browser clients.

## Layout

```
proxy.ts                               ← CORS proxy (Next.js 16)
vercel.json                            ← region (iad1) + function timeout
app/
  layout.tsx
  page.tsx
  api/
    health/route.ts
    products/scan/[barcode]/route.ts   ← M1 scan route
db/
  schema.ts                            ← Drizzle schema
  client.ts                            ← Lazy Drizzle client
lib/
  auth.ts
  logger.ts
  normalize.ts                         ← OFF → canonical Product
  scoring/
    constants.ts                       ← ported from Expo app
    food-grooming.ts                   ← pure scoring fn
    index.ts                           ← scoreProduct() entry
  sources/
    openfoodfacts.ts                   ← OFF v2 adapter + zod
types/
  guardscan.ts                         ← mirror of Expo types
scripts/
  smoke.ts                             ← smoke test
```

## Attribution

Product data from [Open Food Facts](https://world.openfoodfacts.org), licensed under the [Open Database License](https://opendatacommons.org/licenses/odbl/1-0/). The Expo app's About screen surfaces this attribution — do not remove.

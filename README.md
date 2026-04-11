# guardscan-api

Backend for the GuardScan mobile app. Next.js 16 on Vercel Fluid Compute, Supabase Postgres via Drizzle, Open Food Facts + Open Beauty Facts + NIH DSLD as data sources, and Claude Vision (via OpenRouter) for user-submission OCR.

See [CLAUDE.md](CLAUDE.md) for codebase conventions and [docs/README.md](docs/README.md) for the documentation index.

## Status

| Milestone | Status |
|---|---|
| M1 — Scan via OFF + DB schema | **shipped** |
| M1.5 — Multi-source scan (OBF + DSLD) | **shipped** |
| M2 — Cron ingest (OBF delta + DSLD weekly) | **shipped** |
| M2.5 — Recommendations + alternatives API | **shipped** |
| M3.0 — User submissions + CLI admin review | **shipped** |
| M3.1 — Auto-publish via Claude Vision OCR | **shipped** |
| MVP sprint — Search + auth flip + supplement submission flow | **in progress** |
| M3.2 — On-device auto-crop | deferred |
| M5 — Commercial provider fallback | deferred |
| Supplement scoring | deferred (post-MVP, see [docs/post-mvp/supplement-scoring.md](docs/post-mvp/supplement-scoring.md)) |

Authoritative state: [docs/status.md](docs/status.md). Current sprint: [docs/mvp-sprint-plan.md](docs/mvp-sprint-plan.md).

## Quickstart

```bash
npm install
# Set OFF_USER_AGENT at minimum. See the Environment section below.
npm run dev
```

Smoke-test the scan endpoint against a known barcode:

```bash
# Nutella — OFF test barcode
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

`scripts/smoke.ts` scans `3017620422003` and asserts a normalized `ScanResult` comes back with an image URL and a computed score. For authenticated runs use `SMOKE_DEV_USER_ID=<id>` (with `ALLOW_DEV_AUTH=true`) locally, or `SMOKE_AUTH_TOKEN=<jwt>` against a deployed environment.

## Scripts

```bash
npm run dev                        # Next.js dev server (port 3000)
npm run build                      # Production build
npm run lint                       # ESLint
npm run smoke                      # E2E smoke test

# Database
npm run db:generate                # Generate Drizzle migration files after schema change
npm run db:migrate                 # Apply pending migrations (requires DATABASE_URL)
npm run db:studio                  # Drizzle Studio UI
npm run db:coverage                # Print catalog coverage (counts by category, source, score)

# Backfills
npm run db:rescore                 # Rescore rows missing a score using persisted ingredients
npm run db:backfill:subcategory    # LLM/keyword subcategory backfill

# Seeds
npm run db:seed:dictionary         # Ingredient dictionary
npm run db:seed:top                # Top OFF products
npm run db:seed:grooming           # Top men's-grooming OBF products
npm run db:seed:supplements        # DSLD supplements
npm run db:seed:all                # All of the above in order

# Admin
npm run admin:submissions          # List pending user submissions
npm run admin:review <id>          # Review + publish / reject a submission
```

## Architecture

```
Expo app ──▶ Vercel Fluid Compute (Node.js) ──▶ Supabase Postgres (us-east)
                         │
                         ├── OFF / OBF / DSLD adapters (lib/sources/)
                         ├── Normalization (lib/normalize.ts)
                         ├── Scoring — pure function (lib/scoring/)
                         ├── Dictionary lookup (lib/dictionary/)
                         ├── Claude Vision OCR (lib/ocr/ via OpenRouter)
                         └── Supabase Storage (submission photos)
```

Request flow for `GET /api/products/scan/:barcode`:

1. Check DB cache. Serve on hit whenever ingredients are present (score may be null for supplements).
2. On miss, fetch OFF + OBF in parallel. Route supplements to the DB-cached DSLD pool.
3. Normalize → canonical `Product`.
4. Score (pure function; supplements currently return `score: null` — see [docs/post-mvp/supplement-scoring.md](docs/post-mvp/supplement-scoring.md)).
5. Return `ScanResult`. Write-through cache via Next.js `after()` (non-blocking).

Unknown barcodes return `404 { capture: true }`, which triggers the submission flow in the Expo client. Claude Vision pre-extracts fields and, when confidence is high enough, auto-publishes the product so the next scan returns a hit.

Scoring is transparent, deterministic, and personalized by life stage. Full methodology: [docs/architecture/scoring.md](docs/architecture/scoring.md).

Key architectural commitments:

- **Scoring is a pure function.** `lib/scoring/index.ts` takes a product + optional life stage and returns a `ScoreBreakdown` with no I/O. Constants mirror the Expo client and changes must land in both places.
- **Unknown ingredients resolve to Neutral.** Charter requirement — never penalize an ingredient we haven't evaluated.
- **Types live in `types/guardscan.ts`** and must stay in sync with the Expo app. Breaking changes require coordination.
- **Auth is default-deny.** `lib/auth.ts` rejects unauthenticated callers unless `AUTH_ENABLED=false` is explicitly set in a non-production environment. See [docs/architecture/security.md](docs/architecture/security.md).
- **Rate limiting is applied in `proxy.ts`** before routes run. Scan endpoints get a tighter limit than the rest.

## Environment

| Variable | Required | Purpose |
|---|---|---|
| `DATABASE_URL` | yes | Supabase Postgres Transaction pooler URL (port 6543) |
| `OFF_USER_AGENT` | yes | Open Food Facts / Open Beauty Facts require a UA. Format: `GuardScan/1.0 (contact@example.com)` |
| `SUPABASE_URL` | yes | Supabase project URL (submission photo storage) |
| `SUPABASE_SERVICE_ROLE_KEY` | yes | Service-role key for Storage + admin ops |
| `SUPABASE_JWT_SECRET` | yes | JWT Secret (Supabase → Settings → API → JWT Settings) — verifies Expo-client Bearer tokens |
| `OPENROUTER_API_KEY` | yes | Claude Vision via OpenRouter (M3.1 OCR) |
| `CRON_SECRET` | yes (prod) | Authenticates `/api/cron/*` routes — Vercel forwards `Authorization: Bearer <CRON_SECRET>` automatically |
| `ADMIN_USER_IDS` | yes (prod) | Comma-separated Supabase user IDs that may call admin endpoints / CLI |
| `AUTH_ENABLED` | no | Absent or any value ≠ `"false"` → auth on. `"false"` is rejected in production (startup throw). |
| `ALLOW_DEV_AUTH` | no | `"true"` to accept the `X-Dev-User-Id` header. **Local dev only — never in production.** |
| `AUTO_PUBLISH_ENABLED` | no | Kill switch. `"false"` disables auto-publish without a redeploy. |
| `OPENROUTER_MODEL` | no | Override the default Claude model used by the OCR path. |
| `PROVIDER_FALLBACK_ENABLED` | no | M5 flag for commercial fallback. Keep `false`. |
| `PROVIDER_API_KEY` | no | M5 commercial provider API key. Unused today. |
| `LOG_LEVEL` | no | `debug` \| `info` \| `warn` \| `error`. Defaults to `info`. |

Manage with `vercel env add`, pull locally with `vercel env pull .env.local`.

## Deployment

Deployed on Vercel Fluid Compute, region `iad1`. Function timeout 30s (`app/api/**`), 300s for cron routes (`app/api/cron/**`). Database is Supabase Postgres (US East) accessed via the Transaction pooler (port 6543).

First deploy:

```bash
npm i -g vercel
vercel link
# Add every required env var listed in the table above
vercel env add DATABASE_URL
vercel env add OFF_USER_AGENT
# ...
vercel deploy --prod
```

DB migrations:

```bash
npm run db:migrate
```

Scheduled jobs (configured in [vercel.json](vercel.json)):

| Job | Schedule | Source |
|---|---|---|
| `/api/cron/obf-delta` | `0 3 * * *` | OBF daily delta JSONL |
| `/api/cron/dsld-sync` | `0 5 * * 0` | DSLD weekly supplement sync |

## Layout

```
proxy.ts                               ← CORS + IP rate limiting (Next.js 16 proxy)
vercel.json                            ← region, cron, function timeouts
app/
  api/
    health/route.ts                    ← liveness
    products/
      scan/[barcode]/route.ts          ← main scan endpoint
      search/route.ts                  ← POST full-text search (MVP sprint)
      search/suggestions/route.ts      ← autocomplete
      submit/route.ts                  ← user submissions (M3.0/M3.1)
      [id]/route.ts                    ← product detail
      [id]/alternatives/route.ts       ← same-subcategory alternatives
      [id]/score/route.ts              ← score detail
    profiles/me/…                      ← profile, history, favorites
    recommendations/route.ts           ← M2.5 recommendations
    push/register/route.ts
    cron/obf-delta/route.ts            ← M2 OBF ingest (300s)
    cron/dsld-sync/route.ts            ← M2 DSLD ingest (300s)
db/
  schema.ts                            ← Drizzle schema
  client.ts                            ← Lazy Drizzle client
lib/
  auth.ts                              ← JWT verify, admin gate, dev header
  logger.ts
  normalize.ts                         ← OFF / OBF / DSLD → canonical Product
  subcategory.ts                       ← keyword subcategory hints
  sources/                             ← OFF / OBF / DSLD adapters + Zod schemas
  scoring/                             ← pure scoring (index, food-grooming, constants)
  dictionary/                          ← in-memory curated ingredient map (~147 entries)
  ocr/                                 ← Claude Vision via OpenRouter
  submissions/                         ← auto-publish + CLI helpers
  storage/                             ← Supabase Storage client
  cron/                                ← shared ingest helpers (upsertProduct, fetchGzipJsonl)
  llm/classifier.ts                    ← subcategory LLM fallback
types/
  guardscan.ts                         ← shared types (must mirror Expo app)
scripts/                               ← smoke, seeds, backfills, admin CLI
docs/                                  ← see docs/README.md
```

## Attribution

Product data from:

- [Open Food Facts](https://world.openfoodfacts.org) — [Open Database License](https://opendatacommons.org/licenses/odbl/1-0/)
- [Open Beauty Facts](https://world.openbeautyfacts.org) — Open Database License
- [NIH Dietary Supplement Label Database](https://dsld.od.nih.gov) — public domain (US government work)

The Expo app's About screen surfaces this attribution — do not remove.

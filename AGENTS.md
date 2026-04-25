# AGENTS.md

This file provides guidance to Codex (Codex.ai/code) when working with code in this repository.

## What This Is

GuardScan API — a Next.js 16 (App Router) backend for a barcode product-safety scoring app. Looks up food/grooming/supplement products by barcode, scores ingredients against a curated dictionary, and returns a personalized safety score.

## Commands

```bash
npm run dev          # Start local dev server (port 3000)
npm run build        # Production build
npm run lint         # ESLint
npm run smoke        # E2E smoke test against localhost:3001 (or $API_URL)

npm run db:generate  # Generate Drizzle migration files after schema changes
npm run db:migrate   # Apply pending migrations (requires DATABASE_URL)
npm run db:studio    # Open Drizzle Studio UI for DB inspection
```

Smoke test scans barcode `3017620422003` and validates the full `ScanResult` shape.

## Architecture

**Request flow for `GET /api/products/scan/:barcode`:**
1. Check DB cache (skipped if `DATABASE_URL` unset — M1 DB is optional)
2. Fetch from Open Food Facts v2 API on cache miss
3. Normalize OFF response → canonical `Product` type (`lib/normalize.ts`)
4. Score product (`lib/scoring/`) — pure function, no I/O
5. Return `ScanResult`; write to DB cache via `after()` (non-blocking background job)

**Key architectural decisions:**
- **DB is optional in M1.** All routes handle `DATABASE_URL` being absent; the lazy client in `db/client.ts` only throws if code actually tries to use DB.
- **Scoring is a pure function.** `lib/scoring/food-grooming.ts` takes a product + life stage, returns `ScoreBreakdown` with no I/O.
- **Ingredient dictionary is in-memory.** `lib/dictionary/seed.ts` has ~60 curated entries loaded into a Map at startup (`lib/dictionary/lookup.ts`). Unknown ingredients always resolve to NEUTRAL — this is a charter requirement.
- **Types in `types/guardscan.ts` must stay in sync with the Expo app.** Breaking changes require coordination.

## Key Files

| Path | Role |
|---|---|
| `app/api/products/scan/[barcode]/route.ts` | Main scan endpoint |
| `app/api/health/route.ts` | Health check |
| `types/guardscan.ts` | Shared types (Product, ScanResult, ScoreBreakdown) — must match Expo app |
| `lib/sources/openfoodfacts.ts` | OFF v2 API adapter + Zod schema |
| `lib/normalize.ts` | OFF payload → canonical Product |
| `lib/scoring/index.ts` | Scoring entry point (routes by category) |
| `lib/scoring/food-grooming.ts` | Pure scoring logic |
| `lib/scoring/constants.ts` | Rating bands, flag deductions, life-stage multipliers |
| `lib/dictionary/seed.ts` | Curated ingredient entries |
| `lib/dictionary/lookup.ts` | In-memory Map lookup |
| `db/schema.ts` | Drizzle table definitions |
| `db/client.ts` | Lazy Drizzle client (max 5 connections, 20s idle timeout) |
| `lib/auth.ts` | M1 auth: `X-Dev-User-Id` header or Bearer token |
| `proxy.ts` | CORS handler for `/api/*` OPTIONS preflight |

## Scoring Algorithm (v1.2.0 — subtract-only)

1. Start at 100. Iterate ingredients by position (high=1–3, mid=4–8, low=9+).
2. Deduct based on flag × position tier (NEGATIVE: −15/−10/−5; CAUTION: −8/−5/−3). Positive flags do NOT contribute to the numeric score.
3. If ingredient is fertility/testosterone-relevant and deduction is negative, apply life-stage multiplier (1.0–1.5×).
4. Clamp to 0–100 → ingredient safety score.
5. If Nutri-Score is present: combine 60% nutritional quality + 40% ingredient safety. Otherwise 100% ingredient safety.
6. Rating bands: ≥80 Excellent, ≥60 Good, ≥40 Mediocre, <40 Poor.

See `docs/architecture/scoring-v1.2-subtract-only-report.md` for the rationale behind this design.

## Environment Variables

```
OFF_USER_AGENT       # Required: "GuardScan/1.0 (your@email.com)"
DATABASE_URL         # Optional in M1: Supabase Postgres Transaction pooler (port 6543)
AUTH_ENABLED         # Optional: true to enforce auth checks
LOG_LEVEL            # Optional: debug|info|warn|error (default: info)
SUPABASE_JWT_SECRET  # M1.5+: not used yet
```

## Deployment (Vercel)

Region: `iad1`. Function timeout: 30s. First deploy:

```bash
npm i -g vercel
vercel link
vercel env add DATABASE_URL
vercel env add OFF_USER_AGENT
vercel deploy --prod
```

## Milestones

| Milestone | Status | Summary |
|---|---|---|
| M1 | In Progress | Scan via OFF, optional DB cache, ingredient scoring |
| M2 | Pending | OBF (grooming) + DSLD (supplements) |
| M3 | Pending | Search + DB-backed ingredient dictionary |
| M4 | Pending | Cron ingest |
| M5 | Pending | Commercial provider fallback (Nutritionix) |
| M6 | Pending | User submissions + OCR |

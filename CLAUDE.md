# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

GuardScan API — a Next.js 16 (App Router) backend for a barcode product-safety scoring app. Looks up food/grooming/supplement products by barcode, scores ingredients against a curated dictionary, and returns a personalized safety score.

## Commands

```bash
npm run dev          # Start local dev server (port 3000)
npm run build        # Production build
npm run lint         # ESLint
npm run smoke        # E2E smoke test against localhost:3001 (or $API_URL)
npm run parity       # Compare OFF vs OBF versions of the same product

# Database
npm run db:generate  # Generate Drizzle migration files after schema changes
npm run db:migrate   # Apply pending migrations (requires DATABASE_URL)
npm run db:studio    # Open Drizzle Studio UI for DB inspection
npm run db:coverage  # Count products by category/source/score
npm run db:rescore   # Recalculate scores for all cached products

# Seeding
npm run db:seed:dictionary  # Load curated ingredient dictionary
npm run db:seed:top         # Seed top 100 OFF products
npm run db:seed:grooming    # Seed top OBF grooming products
npm run db:seed:supplements # Seed DSLD supplement catalog
npm run db:seed:all         # Run all seeds in order

# Enrichment & admin
npm run enrich:pubchem      # Fetch PubChem CIDs for dictionary ingredients
npm run admin:submissions   # List/manage pending user submissions
```

There is **no formal test runner** (no Jest/Vitest). Validation is done via smoke scripts and the scripts in `scripts/`.

## Architecture

**Request flow for `GET /api/products/scan/:barcode`:**
1. `proxy.ts` applies rate limiting (20 req/min per IP for scan routes; 60 for other `/api/*`)
2. Check DB cache (skipped if `DATABASE_URL` unset)
3. Fetch from the appropriate source API (OFF → OBF → DSLD) on cache miss
4. Normalize response → canonical `Product` type (`lib/normalize.ts`)
5. Score product (`lib/scoring/`) — pure function, no I/O
6. Return `ScanResult`; write to DB cache via `after()` (non-blocking)

**Key architectural decisions:**
- **DB is optional.** All routes handle `DATABASE_URL` being absent; `db/client.ts` only throws when DB is actually used.
- **Scoring is a pure function.** `lib/scoring/food-grooming.ts` takes a product + life stage, returns `ScoreBreakdown` with no I/O.
- **Ingredient dictionary is in-memory.** ~60 curated entries loaded into a Map at startup (`lib/dictionary/lookup.ts`). Unknown ingredients always resolve to NEUTRAL — charter requirement.
- **`proxy.ts` is the rate-limiter + CORS handler**, not a Next.js middleware file. It intercepts all `/api/*` routes with a per-instance sliding-window rate limiter and handles `OPTIONS` preflight.
- **Multi-source scanning.** Sources tried in order: Open Food Facts → Open Beauty Facts → NIH DSLD. Each has its own adapter in `lib/sources/`.
- **LLM pipeline via OpenRouter.** `lib/llm/classifier.ts` uses a Google Gemma model for subcategory inference; `lib/ocr/claude-vision.ts` uses Claude Vision to analyze user submission photos for auto-publish.
- **Types in `types/guardscan.ts` must stay in sync with the Expo app.** Breaking changes require coordination.

## Key Files

| Path | Role |
|---|---|
| `app/api/products/scan/[barcode]/route.ts` | Main scan endpoint |
| `app/api/health/route.ts` | Health check |
| `proxy.ts` | Rate limiter (20/60 req/min) + CORS preflight for all `/api/*` |
| `types/guardscan.ts` | Shared types (Product, ScanResult, ScoreBreakdown) — must match Expo app |
| `lib/sources/openfoodfacts.ts` | OFF v2 adapter + Zod schema |
| `lib/sources/openbeautyfacts.ts` | OBF adapter |
| `lib/sources/dsld.ts` | NIH DSLD supplement adapter |
| `lib/normalize.ts` | Source payload → canonical Product |
| `lib/scoring/index.ts` | Scoring entry point (routes by category) |
| `lib/scoring/food-grooming.ts` | Pure scoring algorithm |
| `lib/scoring/constants.ts` | Rating bands, deduction tables, life-stage multipliers |
| `lib/dictionary/seed.ts` | Curated ingredient entries |
| `lib/dictionary/lookup.ts` | In-memory Map lookup |
| `lib/auth.ts` | JWT verification (HS256 via Web Crypto); `X-Dev-User-Id` in dev |
| `lib/llm/classifier.ts` | LLM-based subcategory classifier (OpenRouter/Gemma) |
| `lib/ocr/claude-vision.ts` | Claude Vision OCR for submission photos |
| `lib/storage/supabase.ts` | Supabase Storage upload/download for submission photos |
| `lib/submissions/auto-publish.ts` | Auto-publish logic (OCR confidence threshold) |
| `db/schema.ts` | Drizzle table definitions |
| `db/client.ts` | Lazy Drizzle client (max 5 connections, 20s idle timeout) |
| `app/api/cron/obf-delta/route.ts` | Cron: daily OBF delta ingest (03:00 UTC) |
| `app/api/cron/dsld-sync/route.ts` | Cron: weekly DSLD sync (Sunday 05:00 UTC) |
| `app/admin/calibration/page.tsx` | Admin UI for score calibration |
| `app/admin/submissions/[id]/page.tsx` | Admin submission review UI |
| `docs/status.md` | Authoritative current state and known limitations |
| `docs/api/endpoints.md` | Complete HTTP route reference |

## Scoring Algorithm (v1.2.0 — subtract-only)

1. Start at 100. Iterate ingredients by position (high=1–3, mid=4–8, low=9+).
2. Deduct based on flag × position tier (NEGATIVE: −15/−10/−5; CAUTION: −8/−5/−3). Positive flags do NOT contribute to the numeric score.
3. If ingredient is fertility/testosterone-relevant and deduction is negative, apply life-stage multiplier (1.0–1.5×).
4. Clamp to 0–100 → ingredient safety score.
5. If Nutri-Score is present: combine 60% nutritional quality + 40% ingredient safety. Otherwise 100% ingredient safety.
6. Rating bands: ≥80 Excellent, ≥60 Good, ≥40 Mediocre, <40 Poor.

See `docs/architecture/scoring-v1.2-subtract-only-report.md` for rationale.

## Environment Variables

```
# Required
OFF_USER_AGENT            # "GuardScan/1.0 (your@email.com)"
DATABASE_URL              # Supabase Postgres Transaction pooler (port 6543)
SUPABASE_JWT_SECRET       # HS256 key for Bearer token verification
SUPABASE_URL              # Supabase project URL
SUPABASE_SERVICE_ROLE_KEY # Admin key (submissions, storage)
OPENROUTER_API_KEY        # For Claude Vision OCR + LLM classifier
CRON_SECRET               # Authorization header value for cron routes

# Optional / feature flags
OPENROUTER_MODEL          # LLM model override (default: google/gemma-4…)
AUTH_ENABLED              # true to enforce JWT checks (default: true)
ALLOW_DEV_AUTH            # true to accept X-Dev-User-Id header (dev only)
ADMIN_USER_IDS            # Comma-separated user IDs with admin access
LOG_LEVEL                 # debug|info|warn|error (default: info)
PROVIDER_FALLBACK_ENABLED # Enable commercial API fallback (default: false)
```

## Deployment (Vercel)

Region: `iad1`. Default timeout: 30s; cron routes: 300s. Config in `vercel.json`.

```bash
vercel link
vercel env add DATABASE_URL
vercel env add OFF_USER_AGENT
vercel deploy --prod
```

## Milestones

| Milestone | Status | Summary |
|---|---|---|
| M1 | Shipped | Scan via OFF, DB cache, ingredient scoring |
| M1.5 | Shipped | OBF + DSLD multi-source scanning |
| M2 | Shipped | Cron ingest (OBF delta + DSLD sync) |
| M2.5 | Shipped | Recommendations + product alternatives API |
| M3 | Shipped | User submissions + Claude Vision OCR + admin dashboard |
| M3.2 | Shipped | Admin submission review UI + calibration tools |
| M4 | Pending | Search + DB-backed ingredient dictionary |
| M5 | Pending | Commercial provider fallback (Nutritionix) |
| M6 | Pending | Supplement-specific scoring model |

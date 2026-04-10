# M2 — Cron Ingest (OBF + DSLD)

**Status:** Planning
**Depends on:** M1.5 (multi-source scanning)
**Exit criteria:** DB grows automatically from OBF daily deltas and DSLD weekly sync. Grooming seed populates ~200 products from target brands.

---

## Goal

Automate product catalog growth so the DB has enough scored products to power recommendations (M2.5) and reduce scan-time API calls to upstream sources. Three ingest jobs:

| Job | Schedule | Products Added |
|---|---|---|
| OBF daily delta | `0 3 * * *` | ~50-200/day (grooming products changed in OBF) |
| DSLD weekly sync | `0 5 * * 0` | ~500-1000/week (supplement labels with valid UPCs) |
| Grooming seed | One-off script | ~200 (top men's grooming brands) |

---

## What Changes

### 1. DB Schema Additions

**Modified file: `db/schema.ts`**

Add `cronState` table to track ingest job progress:
```
cron_state
  job_name        text PK     — 'obf_delta' | 'dsld_sync'
  last_processed_key text     — e.g. last delta filename
  last_run_at     timestamptz
  last_run_status text        — 'success' | 'partial' | 'failed'
  metadata        jsonb       — job-specific counters
```

**New migration** generated via `npm run db:generate`, applied via `npm run db:migrate`. RLS: service_role only (matches existing pattern in `0001_rls_policies.sql`).

### 2. Shared Ingest Helpers

**New file: `lib/cron/ingest-helpers.ts`**

Reusable utilities for all ingest jobs:
- `upsertProduct(db, product, source, score, subcategory)` — insert or update product row + product_ingredients in a single transaction
- `fetchGzipJsonl(url)` — fetch `.json.gz`, decompress with `zlib.gunzipSync()`, parse JSONL lines

### 3. Cron Auth

**New file: `lib/cron/auth.ts`**

Verifies that cron requests come from Vercel (checks `x-vercel-cron` header) or carry a `CRON_SECRET` bearer token. Returns 401 for external callers.

### 4. OBF Daily Delta

**New file: `app/api/cron/obf-delta/route.ts`**

Algorithm:
1. Fetch `https://static.openbeautyfacts.org/data/delta/index.txt` — plain-text list of `.json.gz` filenames (last 14 days)
2. Read `cron_state` for `obf_delta` — get `last_processed_key` (last filename)
3. Process only new filenames (sorted chronologically)
4. For each delta file:
   - Fetch + gunzip + parse JSONL (each line = full OBF product)
   - Normalize via `normalizeObfProduct()`, score via `scoreProduct()`
   - Batch upsert (50 products/batch) into `products` + `product_ingredients`
5. Update `cron_state` with last filename + counts
6. Log summary

Delta files are typically <5MB compressed. The entire daily job completes well within the 5-minute timeout.

### 5. DSLD Weekly Sync

**New file: `app/api/cron/dsld-sync/route.ts`**

Algorithm:
1. Search DSLD with common supplement terms: `["vitamin", "mineral", "protein", "probiotic", "omega", "supplement", "capsule"]` — each paginated (size=100)
2. For each search hit: fetch full label via `/v9/label/{_id}`
3. Extract UPC from `upcSku`, normalize (strip spaces)
4. Skip products without a valid UPC (can't be scanned by barcode)
5. Normalize via `normalizeDsldLabel()`, upsert into DB
6. Rate limit: ~600ms between label fetches (DSLD has no documented limits; be conservative)
7. Time-box at 4 minutes (leave margin under Vercel's 5-min cap)

Products without UPCs are skipped — they can't be found by barcode scanning anyway.

### 6. Grooming Seed Script

**New file: `scripts/seed-grooming.ts`**

One-off manual script (not a cron). Searches OBF by brand name for ~12 target brands:
- Old Spice, Dove Men+Care, Nivea Men, Dr. Squatch, Every Man Jack, Harry's
- Duke Cannon, Bulldog, Jack Black, Cremo, Baxter of California, Brickell

For each brand: search OBF (`/cgi/search.pl?search_terms={brand}&json=1&page_size=25`), fetch full products, normalize, score, upsert. Target: ~200 products.

Run: `npx tsx scripts/seed-grooming.ts`

### 7. Vercel Config

**Modified file: `vercel.json`**
```json
{
  "regions": ["iad1"],
  "functions": {
    "app/api/**": { "maxDuration": 30 },
    "app/api/cron/**": { "maxDuration": 300 }
  },
  "crons": [
    { "path": "/api/cron/obf-delta", "schedule": "0 3 * * *" },
    { "path": "/api/cron/dsld-sync", "schedule": "0 5 * * 0" }
  ]
}
```

---

## Files Summary

| Action | File | What |
|---|---|---|
| New | `lib/cron/ingest-helpers.ts` | Batch upsert + gzip fetch utilities |
| New | `lib/cron/auth.ts` | Cron request verification |
| New | `app/api/cron/obf-delta/route.ts` | OBF daily delta ingest |
| New | `app/api/cron/dsld-sync/route.ts` | DSLD weekly supplement sync |
| New | `scripts/seed-grooming.ts` | One-off grooming brand preload |
| Modify | `db/schema.ts` | Add `cronState` table |
| Modify | `vercel.json` | Cron schedules + cron route timeout |

**New env var (optional):** `CRON_SECRET` — alternative auth for manually triggering cron jobs in development.

---

## Verification

1. **OBF delta**: `curl -H "Authorization: Bearer $CRON_SECRET" localhost:3000/api/cron/obf-delta` — products appear in DB with `source='obf'`, `cron_state` updated
2. **DSLD sync**: Same pattern — supplement products appear with `source='dsld'` and valid barcodes
3. **Idempotency**: Run OBF delta twice — no duplicate products (upsert by barcode)
4. **Error resilience**: DSLD 500s trigger retries; partial progress is saved
5. **Grooming seed**: `npx tsx scripts/seed-grooming.ts` — ~200 products inserted
6. **Scan hits cache**: After ingest, scanning a known OBF/DSLD barcode returns from DB cache (no upstream call)

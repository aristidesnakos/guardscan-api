# Rescore & Backfill Playbook

Operational runbook for the two maintenance scripts that keep cached scores in
sync with the live dictionary and scoring algorithm.

**Last updated:** 2026-04-26

---

## Overview

Two scripts touch production data:

| Script | What it does | When to run |
|---|---|---|
| `scripts/backfill-normalized.ts` | Writes the canonical `normalized` key to legacy `product_ingredients` rows that were inserted before the P0 fix (2026-04-24). | Once — already run 2026-04-26. Re-run only if new legacy rows are imported from a pre-P0 dump. |
| `scripts/rescore-products.ts` | Re-computes `score` + `scoreBreakdown` for all products where `score IS NULL`. | After each dictionary change that affects scoring, or after seeding new products. |

Neither script touches the OFF/OBF/DSLD APIs. Both are safe to kill and re-run
— they are idempotent by design.

---

## 1. Backfill normalized column

Populates `product_ingredients.normalized` for rows inserted before the P0 fix.

### Prerequisites

- `DATABASE_URL` set to the production **Transaction pooler** (port 6543).
- You are on `main` with the P0 commit (`b06ff6d`) already deployed.

### Steps

```bash
# Step 1: dry run — see how many rows would be updated
DATABASE_URL="postgres://..." npx tsx scripts/backfill-normalized.ts --dry

# Step 2: apply
DATABASE_URL="postgres://..." npx tsx scripts/backfill-normalized.ts --apply
```

### Verify

Run in Supabase SQL editor or `psql`:

```sql
SELECT count(*)
FROM product_ingredients pi
JOIN ingredient_dictionary id ON pi.normalized = id.normalized;
```

A non-zero count confirms the backfill worked and the lookup join is resolving.
The exact count will grow over time as the dictionary expands; a zero count after
backfill is a failure.

### Rollback

The script only fills rows where `normalized` was empty or incorrect. It does not
delete data. If the run produces unexpected output, stop it (`Ctrl-C`), inspect
the affected rows, and re-run `--dry` to audit before applying again.

---

## 2. Rescore products

Re-scores all products where `score IS NULL` — typically after:

- A dictionary change that affects `flag` values (e.g. adding a new `negative` entry).
- Seeding new products via `db:seed:top`, `db:seed:grooming`, or `db:seed:supplements`.
- After P3 shipped (2026-04-26), re-score to correct titanium-dioxide-affected food products.

### Prerequisites

- `DATABASE_URL` set to the production Transaction pooler.
- The target commit is deployed (scoring changes only take effect on the running code).

### Steps

```bash
# Step 1: dry run — preview how many products would be scored
DATABASE_URL="postgres://..." npx tsx scripts/rescore-products.ts --dry

# Optional: limit to a subset first
DATABASE_URL="postgres://..." npx tsx scripts/rescore-products.ts --dry --limit 20

# Step 2: apply
DATABASE_URL="postgres://..." npx tsx scripts/rescore-products.ts

# Or with a limit for incremental application
DATABASE_URL="postgres://..." npx tsx scripts/rescore-products.ts --limit 500
```

### What gets scored / skipped

| Case | Outcome |
|---|---|
| `score IS NULL` + has ingredients + non-supplement | Scored and written |
| `score IS NULL` + has ingredients + supplement | Skipped (M2 deferred) |
| `score IS NULL` + zero ingredient rows | Skipped — needs Phase B OFF re-fetch |
| `score IS NOT NULL` | Never touched (idempotent guard) |

### Verify

```sql
SELECT
  category,
  count(*) FILTER (WHERE score IS NULL)     AS null_score,
  count(*) FILTER (WHERE score IS NOT NULL) AS has_score
FROM products
GROUP BY category
ORDER BY category;
```

After a successful run, `null_score` for `food` and `grooming` should be close to
zero (residual NULLs are zero-ingredient products).

### Rollback

The script only writes to rows where `score IS NULL` at the moment of the UPDATE.
An accidental run cannot corrupt already-scored rows. If an in-progress run is
killed mid-way, re-running picks up from where it left off.

---

## 3. Rescore cadence policy

**Current policy (2026-04-26):** manual, on-demand.

Trigger a rescore after any of the following:

1. A dictionary entry is added or changed that carries a `negative` or `caution` flag.
2. The scoring algorithm constants change (e.g. deduction values in `lib/scoring/constants.ts`).
3. A seed of new products lands (OBF delta cron handles ongoing updates automatically; this only applies to bulk seed scripts).
4. A P3-class bug is fixed that changes how a category-specific ingredient is resolved.

**Automation:** decide whether to automate (weekly cron, post-deploy hook, or
after-each-PR) before launch. See the open question in `docs/proposals/pipeline-remediation.md`.

---

## 4. Running `npm run parity` after a rescore

After rescoring, run the cache-vs-fresh parity check to confirm cached and live
scores agree:

```bash
# Against the local dev server
SMOKE_DEV_USER_ID=local npm run parity

# Against a preview deployment
API_URL=https://my-preview.vercel.app SMOKE_AUTH_TOKEN=... npm run parity
```

All assertions should pass. A failure means a hydration or ordering regression has
been introduced — investigate before promoting to production.

---

## 5. Quick reference — environment variables

| Variable | Description |
|---|---|
| `DATABASE_URL` | Supabase Transaction pooler URL (port 6543). Required for both scripts. |
| `API_URL` | Override for parity-check target (default: `http://localhost:3001`). |
| `SMOKE_DEV_USER_ID` | Dev auth header value (when `ALLOW_DEV_AUTH=true`). |
| `SMOKE_AUTH_TOKEN` | Bearer token for staging/prod parity check. |

# Translation Backfill — Living Proposal

**Last updated:** 2026-05-13 (end of Phase 2)
**Status:** Phases 1 + 2 shipped to prod. Phase 3 (backfill apply) pending.
**Owner:** Ari

---

## TL;DR for tomorrow

The clobber loop is closed. New foreign-named ingest is translated synchronously
and the cron preserves it. The remaining work is one-shot: harden the spike
script and run it across the existing 223 foreign catalog rows.

Resume here:

```bash
cd /Users/ari/Documents/guardscan-api

# Sanity check Phase 2 still passes
npm run test:translation           # expect: 30 passed, 0 failed

# Pre-flight: how many foreign rows are left?
npx tsx scripts/audit-name-language.ts    # untracked spike script

# When ready for Phase 3, follow §3 below.
```

---

## 1. What's live in prod (Phases 1+2)

**Schema (commit `ea9c2a5`):**
- `products.original_name text`
- `products.source_language text`
- `products.translation_status text` — CHECK in
  `{auto, manual, pending, failed, disputed}` ∪ NULL
- Partial index `products_translation_status_idx WHERE translation_status IS NOT NULL`

**Runtime (commit `d1fa784`):**
- `lib/translation.ts` — `looksForeign()` heuristic + `translateProductName()`
  LLM client. 5s timeout. Never throws. English-loanword allowlist (maté,
  naïve, açaí, kombucha, kefir, yerba, café, résumé, soufflé, edamame).
- `lib/cron/ingest-helpers.ts:resolveClaim` — decision tree:
  - `manual` → no field touched. Sacred.
  - `auto|pending|failed|disputed` → preserve `name`, refresh `original_name`
    with incoming source value (audit trail).
  - no claim + `looksForeign()` + LLM enabled → sync translate, status=`auto`
    on success, `failed` on error.
  - no claim + `looksForeign()` + no API key → status=`pending`, name written
    as-is, original captured. Outbox-eligible.
  - no claim + English → write through.
- `app/api/products/scan/[barcode]/route.ts` — inline upsert deleted; calls
  `upsertProduct` so it can't bypass the claim.
- `scripts/test-translation-claim.ts` — 30/30 round-trip suite. Fixture
  barcodes `9999900000001-4`, cleaned up on exit.

**Verified:**
- Live LLM run inside test: `Bagnoschiuma Doccia → Shower Gel`, lang=it.
- Manual status survives upstream re-emit (`Shampooing nutritif` ignored).
- `auto` row preserves English name, refreshes original on re-emit.

---

## 2. What's still spike (untracked, intentional)

These files exist in the working tree but are NOT committed. They were used
to research the problem and prove the cost/quality envelope. Each needs
hardening before Phase 3 applies them.

| File | Purpose | Hardening needed |
|---|---|---|
| `scripts/translate-names.ts` | One-shot backfill writer | --yes guard, DB invariant check (count ≥ 2000 or abort), resume cursor, exclude pomenatal SKUs |
| `scripts/audit-name-language.ts` | Pre/post audit; counts suspects | Already fit for purpose — keep untracked or commit as-is |
| `scripts/output/*.jsonl` | Spike audit logs from May 13 | Add `scripts/output/` to .gitignore before any commit |

Tomorrow's first decision: commit `audit-name-language.ts` as Phase 3 part 1
(harmless read-only audit, will be useful as the weekly cron), keep
`translate-names.ts` untracked until §3 hardening lands.

---

## 3. Phase 3 plan

Execution order. Each step has an exit criterion — don't cross without it.

### 3a. Harden the script

Edits to `scripts/translate-names.ts`:

1. Add `scripts/output/` and `*.jsonl` to `.gitignore` BEFORE touching the
   script (so eyeballed runs don't accidentally get committed).
2. Add `--yes` flag. Without it, `--apply` errors with a message.
3. Add DB invariant check at boot: query `SELECT count(*) FROM products`.
   Abort if < 2000 — that means we're pointing at a dev/empty DB.
4. Add resume cursor at `scripts/output/.translate-cursor` (single line, last
   processed barcode). Filter:
   `WHERE original_name IS NULL AND (translation_status IS NULL OR translation_status = 'failed')`.
5. Add audit table write alongside JSONL — schema:
   ```
   CREATE TABLE translation_audit (
     id bigserial PRIMARY KEY,
     barcode text NOT NULL,
     source_text text NOT NULL,
     translated_text text,
     model text NOT NULL,
     prompt_hash text NOT NULL,
     ts timestamptz NOT NULL DEFAULT now()
   );
   ```
   Migration 0009. Append-only. Drives quality monitoring + rollback evidence.
6. Add pomenatal pre-filter. Skip rows where `brand` matches a known pomenatal
   SKU. For first pass — translate those manually if needed. (Maintain a small
   `BRAND_DENYLIST = ['<…>']` constant. Leave empty for now if no SKUs known.)

**Exit:** dry-run on 50 rows produces clean JSONL + audit table populated +
resume cursor written.

### 3b. Model A/B

Hand-label 30 golden translations covering FR/IT/DE/NL/PT/ES, mixing:
- 5 brand-present-inline (e.g. "Williams Après-Rasage …")
- 5 brand-absent (e.g. "Crème mani erboristica")
- 5 with volumes (125ml, 250 g)
- 5 scent/flavor names
- 5 INCI-heavy
- 5 ambiguous

Run translate-names against each model, score against golden:
- `anthropic/claude-haiku-4.5`
- `google/gemma-4-26b-a4b-it` (current default)
- `google/gemma-9b-it` (cheapest)

Pick cheapest that hits ≥27/30. Lock in `.env` `OPENROUTER_TRANSLATOR_MODEL`.
Re-test `npm run test:translation` after env change (the intake-side runtime
also reads this env).

**Exit:** model decided, env updated locally, A/B results pasted into this doc.

### 3c. Dry-run 80 rows

```bash
npx tsx scripts/translate-names.ts --limit 80
```

Eyeball the audit JSONL. Check:
- Brand-present rows preserve brand
- Brand-absent rows don't get hallucinated brands
- Volumes preserved exactly
- No scents/flavors invented
- INCI strings stay INCI

If any class fails, fix prompt or filter. Re-dry-run until clean.

**Exit:** 80-row JSONL reviewed and signed off in this doc with a date.

### 3d. Full backfill

```bash
npx tsx scripts/translate-names.ts --apply --yes
```

Watch counts: translated, errored, total tokens, total cost (target: ≈$0.05).

**Exit:** apply complete, no errors > 5% of rows.

### 3e. Audit

```bash
npx tsx scripts/audit-name-language.ts
```

Suspect count should drop near zero. Document residuals (legitimate foreign
brand names) in this doc.

**Exit:** ≤5 residuals OR each documented as legitimate.

### 3f. Watch one cron cycle

Wait for next `0 3 * * * UTC` OBF delta. After cycle, re-run audit. Confirm
no regression (suspect count stable). This is the durability proof for the
combined Phase 2 + 3 release.

**Exit:** post-cron audit count = pre-cron audit count (modulo new ingest).

---

## 4. Phase 4 — hardening (post-Phase 3, lower urgency)

- **Weekly audit cron**: new route `app/api/cron/audit-names/route.ts`,
  schedule `0 4 * * 1` (Monday 4 UTC, one hour after OBF). Runs the audit
  logic, logs suspect count, alerts if > 10.
- **Quality signal**: extend user report flow (frontend
  `docs/product/FEATURES/USER-REPORTING.md`) so "wrong name" category writes
  `translation_status='disputed'`. Surfaces in admin dashboard for review.
- **Frontend affordance** (optional, mangood-side): on product detail page,
  if `original_name IS NOT NULL`, show small line "Originally:
  {original_name}." Defuses "I see English but packaging is Italian"
  cognitive mismatch.

---

## 5. Open questions still relevant

- **`raw_ingredients` translation**: scoped out of this work. Mostly INCI
  (universal), so OK. Worth re-measuring after backfill — `SELECT count(*)
  FROM products WHERE original_name IS NOT NULL AND raw_ingredients LIKE …`.
- **Search index**: catalog uses no `tsvector` index on `products.name`
  (verified in current-schema.md). No rebuild concern.
- **Pomenatal regulated names**: still unaddressed at filter level. Phase 3a
  step 6 adds the denylist scaffolding but list is empty pending product
  decision.
- **Long-tail languages**: audit covers FR/IT/DE/NL/PT/ES. Polish/Czech/Greek
  not measured. If audit shows residual non-Latin scripts after Phase 3,
  decide whether to extend heuristic.

---

## 6. File map (resumption cheat sheet)

```
guardscan-api/
├── db/migrations/0008_translation_columns.sql       # applied prod 2026-05-13
├── db/migrations/current-schema.md                  # prod schema reference
├── db/schema.ts                                     # Drizzle ORM types
├── lib/translation.ts                               # runtime LLM + heuristic
├── lib/cron/ingest-helpers.ts                       # resolveClaim + upsertProduct
├── app/api/products/scan/[barcode]/route.ts         # uses upsertProduct now
├── scripts/test-translation-claim.ts                # npm run test:translation
├── scripts/translate-names.ts                       # SPIKE — harden in 3a
├── scripts/audit-name-language.ts                   # SPIKE — keep as is
└── docs/proposals/
    ├── translation-backfill.md                      # THIS DOC
    └── translation-callers-audit.md                 # Phase 1 caller research
```

## 7. Decision log

- **2026-05-13** — Path A (storage columns) over Path B (read-time translate).
  Reason: kyttara confirmed dead, catalog is single-locale English.
- **2026-05-13** — Synchronous translation over outbox cron. Reason: kills
  race condition between OBF cron and outbox cron; <200ms per foreign row is
  acceptable inside the existing ingest tx.
- **2026-05-13** — 5-state enum over boolean claim. Reason: `manual` needs to
  be sacred independently of `auto`; `disputed` reserved for user reports;
  `pending` covers no-LLM ingest path.
- **2026-05-13** — Refactor scan route to call `upsertProduct` rather than
  duplicate claim logic. Reason: single chokepoint = single audit surface.

## 8. Risks not yet mitigated

- **No quality monitoring post-apply.** A wrong-but-plausible translation
  looks identical to a good one. Phase 4 quality signal is the only planned
  catch. Mitigation: spot-check 50 random `translation_status='auto'` rows
  one week post-apply.
- **Audit table doesn't exist yet.** Phase 3a step 5 introduces migration
  0009. Without it, the JSONL output in `scripts/output/` is the only
  evidence of LLM decisions — local, fragile, easy to lose.
- **LLM provider SPOF.** OpenRouter is single-route. If it 429s mid-backfill,
  resume cursor (3a step 4) recovers; if it 429s during a cron run, foreign
  rows get `translation_status='failed'` and retry on next ingest sight
  (already handled).

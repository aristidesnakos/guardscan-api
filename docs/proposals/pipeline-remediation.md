# Ingredient Pipeline Remediation — Proposal Series

**Status:** ✅ All code complete — awaiting operator decisions D / E / F / G
**Created:** 2026-04-24 · **Last revision:** 2026-04-26
**Scope:** Backend only (`guardscan-api`)
**Research basis:** `docs/proposals/ingredient-pipeline-analysis.md`

---

## What shipped

### Batch 1 — 2026-04-24 (`b06ff6d`)
| ID | What it did |
|---|---|
| **P0** | DB writes now use `normalizeIngredientName()`. Backfill script created. |
| **P1** | OFF `id` field used as `lookupHint`; single shared resolver in `lib/dictionary/resolve.ts`. |
| **P4** | `product_no_ingredients` structured log with `has_ingredients_text` / `_en` flags. |
| **Side effect** | `Ingredient.assessed` + `ScoreBreakdown.assessment_coverage` added to shared types. |

### Batch 2 — 2026-04-26 (`7e4cec5`)
All remaining correctness bugs from the 2026-04-25 audit. One commit, 16 files.

| ID | What it did | Key files |
|---|---|---|
| **P7** | `ORDER BY position` on all 6 ingredient read sites — Postgres order is no longer the position tie-breaker | scan, [id], alternatives, search, recommendations, rescore-products |
| **P2** | `hydrateIngredient()` + `withAssessmentCoverage()` in `lib/dictionary/resolve.ts`; applied to all 7 hydration sites and 2 score-blob reads — personalization flags and `assessment_coverage` are now restored on every cache read | resolve.ts + 5 routes + rescore script |
| **P3** | Two-tier composite index (`${normalized}::${category}` + flat fallback) in `lib/dictionary/lookup.ts`; build-time guard throws on same-category duplicates; `productCategory` threaded through `resolveIngredient` → `hydrateIngredient` → `flagIngredients` — food "titanium dioxide" now returns `negative` (EU-banned) not grooming's `positive` | lookup.ts, resolve.ts, normalize.ts, all hydration sites |
| **P8** | `upsertProduct()` wrapped in `db.transaction()` — orphan product rows on ingredient-insert failure are impossible | ingest-helpers.ts |
| **P6** | `normalizeIngredientName()` replaces `toLowerCase().trim()` in admin submission preview + admin CLI | submissions/[id]/route.ts, admin-submissions.ts |
| **P9** | `scripts/parity-check.ts` — scans each test barcode twice, asserts score / rating / personalized / assessment_coverage / flagged count / ingredient ordering match between reads. `npm run parity`. | scripts/parity-check.ts, package.json |
| **Obs** | `cache_hit` on every `scan_ok`/`scan_ok_cached` event; `upstream_ms` on fresh scans; `files_available` + `files_processed` on OBF cron completion | scan route, obf-delta route |
| **Ops** | `docs/operations/rescore-playbook.md` — when/how to run backfill + rescore, verification queries, rollback, cadence guidance | docs/operations/rescore-playbook.md |
| **Lint** | `next lint` → `eslint .` (Next 16 removed `next lint`) | package.json |

### Operator steps completed — 2026-04-26
| # | What | Result |
|---|---|---|
| A | `backfill-normalized.ts --apply` against prod | Done |
| B | Verified with JOIN count query | 6,570 rows joined — backfill confirmed |
| C | `db:rescore` against prod after P3 | 1 food product scored; 852 supplements deferred (M2); 6 zero-ingredient products unchanged (Phase B) |

---

## Open items

These are the only things left before launch. Each has a clear owner.

### Decisions owed by Ari

| # | Decision | Why it's yours | Unblocks |
|---|---|---|---|
| **D** | Manual parity check on 5 prod barcodes: English food (Coca-Cola), non-English food (Nutella), grooming (Gillette gel), supplement, and `?life_stage=actively_trying_to_conceive` personalized scan | Prod smoke; confirms UX from the device | Launch bar sign-off |
| **E** | `GET /api/scans/daily-count` contract: rename to `lifetime-count` **or** convert to a true rolling 24-hour counter. Check Expo client call sites first (search cucumberdude repo) to gauge blast radius. | Product decision — affects Expo contract | C9 (code work) |
| **F** | Set up Vercel observability dashboards. Suggested panels: scan p95 latency split by `cache_hit`, 5xx rate, OBF cron `files_processed` / `upserted` / `errors`, `upstream_ms` p95 for OFF+OBF, zero-ingredient rate from `product_no_ingredients` log. Fields are live in logs as of `7e4cec5`. | Dashboard config is yours | Launch bar sign-off |
| **G** | Rescore cadence policy: manual on-demand / weekly cron / post-deploy hook? Document decision in `docs/operations/rescore-playbook.md` § 3. | Operational policy | — |
| **AGENTS.md** | Untracked file in repo root — commit it or delete it. | Unclear ownership | Clean git status |

### Code work — blocked on decisions above

| # | Task | Blocked on |
|---|---|---|
| **C9** | Implement the chosen `scans/daily-count` contract (rename endpoint or convert to rolling) | Decision E |

---

## Launch bar

Ship when all of the following are green:

- [x] No known correctness bugs: titanium dioxide returns category-correct flag; `ORDER BY position` on all reads
- [x] Backfill complete and join count verified
- [x] Personalization flags restored on cache reads; `assessment_coverage` synthesized for old blobs
- [x] `upsertProduct` atomic; orphan rows impossible
- [x] Rescore playbook documented
- [x] Lint gate working
- [ ] **D** — Manual prod parity check passes (Ari)
- [ ] **F** — Observability dashboards live (Ari)
- [ ] **G** — Rescore cadence policy decided and documented (Ari)
- [ ] **E → C9** — `daily-count` contract resolved (Ari decides, Claude implements)

---

## Summary table

| ID | Problem | Status |
|---|---|---|
| P0 | `normalized` written wrong in DB writes | ✓ Shipped 2026-04-24 (`b06ff6d`) |
| P1 | OFF `id` field ignored; multilingual products miss dictionary | ✓ Shipped 2026-04-24 (`b06ff6d`) |
| P2 | `assessed` + personalization flags + `assessment_coverage` lost on cache reads | ✓ Shipped 2026-04-26 (`7e4cec5`) |
| P3 | Duplicate seed keys silently overwrite (titanium dioxide live) | ✓ Shipped 2026-04-26 (`7e4cec5`) |
| P4 | Zero-ingredient observability | ✓ Shipped 2026-04-24 (`b06ff6d`) |
| P5 | UI coverage thresholds need real data | Deferred — needs ≥1 week of `scan_ok` logs with `assessment_coverage` |
| P6 | Admin/script paths use ad-hoc `toLowerCase().trim()` | ✓ Shipped 2026-04-26 (`7e4cec5`) |
| P7 | No `ORDER BY position` on cached ingredient reads | ✓ Shipped 2026-04-26 (`7e4cec5`) |
| P8 | `upsertProduct` not actually transactional | ✓ Shipped 2026-04-26 (`7e4cec5`) |
| P9 | No cache-vs-fresh parity smoke test | ✓ Shipped 2026-04-26 (`7e4cec5`) |

---

## Findings audit log

- **2026-04-24:** P0, P1, P4 shipped. `assessment_coverage` added as a side effect.
- **2026-04-25 (round 1):** Widened P2 from 3 to 7 sites. Promoted P3 to Hotfix on evidence of live silent overwrite. Added P6. Narrowed P3 by removing the speculative "audit and split 5–10 entries" workstream — the build-time guard makes that unnecessary.
- **2026-04-25 (round 2, colleague review):** Expanded P2 to also restore `fertility_relevant` and `testosterone_relevant` from the dictionary (caching was silently de-personalizing scores). Added P7 (position ordering), P8 (transactional ingest), P9 (parity test). Added Ownership and sequencing section.
- **2026-04-26:** P2/P3/P6/P7/P8/P9 shipped in single commit `7e4cec5`. Backfill run (6,570 joins verified). Rescore run (1 food scored; 852 supplements deferred to M2; 6 zero-ingredient unchanged). Observability fields live. Playbook written. Lint gate fixed. Open items reduced to D/E/F/G/AGENTS.md/C9.

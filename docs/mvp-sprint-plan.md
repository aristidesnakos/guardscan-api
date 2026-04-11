# GuardScan — MVP Sprint Plan

**Audience:** Product Manager + Backend Engineer
**Last updated:** 2026-04-11 (rev 4 — supplements deferred, plan simplified)
**Status:** Source of truth for this sprint. Previous revs archived at the bottom.

---

## What changed in rev 4

1. **Supplements are deferred to a post-MVP phase.** See [docs/post-mvp/supplement-scoring.md](./post-mvp/supplement-scoring.md) for why and what it takes to ship them later.
2. **The catalog-densification scripts (Phase A rescore, Phase B refetch) are out.** Phase A ran and yielded zero net scores (all 601 candidates were supplements). Phase B would have fetched ~400 obscure OBF grooming products — the live user-submission pipeline handles density better than cold-seeding does.
3. **The sprint is now 6 tasks, not 10.** Everything that doesn't directly support "user scans a product, sees an honest result, or adds it themselves" is out.
4. **"Users can add any product — including supplements."** This is the one non-negotiable MVP constraint. Verified against the code and found two small gaps (one scan-route bug, one search-filter gap) that must be fixed before launch.

---

## The MVP in one paragraph

A user opens the app and scans a barcode. They see one of three outcomes:

1. **Known product with a score** — grooming or food. Shows the score, flagged ingredients, and up to 3 better alternatives in the same subcategory.
2. **Known product without a score** — any supplement in the catalog today, or any submitted product for which scoring returned null. Shows the product identity + a "Score pending — supplement scoring is coming soon" state. No alternatives, no score.
3. **Unknown product** — 404 → submission flow → Claude Vision OCR → product persists → next scan returns state 1 or state 2.

Every barcode a user cares about has a path forward. Nothing dead-ends.

---

## Current state (verified 2026-04-11)

| Signal | Value | What it means |
|---|---|---|
| Total products | 1,417 | Launchable size |
| Grooming scored | ~413 of 812 | Remaining 399 either have no ingredients (401) or are an edge case |
| Supplements scored | 0 of 603 | **By design** — scoring is a stub, deferred to post-MVP |
| Food scored | 2 of 2 | Effectively ignore food as a category this sprint |
| Dictionary entries | 147 | Sufficient for MVP |
| Pending user submissions | 8 (7 pending + 1 in_review) | Will be dispositioned in Task A |
| Expo client auth header | `Authorization: Bearer <supabase_jwt>` in prod | Verified in cucumberdude; Task C confirms on preview |
| Auth in production | `AUTH_ENABLED=true` | Already shipped in commit `fd8bda4` |
| Tasks 4–9 from rev 3 | Shipped (auth/docs/search/suggestions/multi-brand markers) | See commit `fd8bda4` |

### What's still broken, verified in code

| # | Gap | File | One-line fix |
|---|---|---|---|
| 1 | Scan cache only serves rows with `scoreBreakdown`. A null-scored supplement 404s on second scan, re-prompting submission forever. | [app/api/products/scan/[barcode]/route.ts:146](../app/api/products/scan/[barcode]/route.ts#L146) | Serve the cached product when ingredients exist, regardless of scoreBreakdown. `ScanResult.score` already permits null. |
| 2 | Search endpoint does not filter `score IS NOT NULL`, so a null-scored supplement would appear in search results. | [app/api/products/search/route.ts:82](../app/api/products/search/route.ts#L82) | Add `isNotNull(products.score)` to the where conditions. Matches the suggestions endpoint pattern. |
| 3 | Auto-publish has no kill switch. A misbehaving Claude Vision version can't be disabled without a redeploy. | [lib/submissions/auto-publish.ts](../lib/submissions/auto-publish.ts) | Gate `tryAutoPublish` on `process.env.AUTO_PUBLISH_ENABLED !== 'false'`. |
| 4 | Expo client has no "pending score" visual state for `score === null`. | cucumberdude product card component | Add one badge + copy: *"Score pending — we'll rate this when supplement scoring ships."* |

All four fit in one PR.

---

## Sprint goals

1. **Ship** the four code gaps above.
2. **Disposition** the 8 pending user submissions and capture empirical signal on auto-publish confidence.
3. **Validate** the pipeline end-to-end on both grooming and supplement test barcodes in a preview deploy.
4. **Promote** to production and dogfood on a real device.
5. **Document** supplement scoring as a deferred post-MVP phase.

Not a goal this sprint:
- Any change to scoring logic, dictionary content, or ingredient sources.
- Re-running data backfills that have already reached their ceiling.
- Designer polish of search/browse UI (picked up separately once supplements land).

---

## Tasks

### Task A — CLI triage helpers + disposition 8 submissions

**Estimate:** ~1 hour. **Blockers:** None.

**Context.** [scripts/admin-submissions.ts](../scripts/admin-submissions.ts) is interactive-only today (`review <id>` blocks on a readline prompt), so the 8 pending submissions can't be dispositioned programmatically. This task adds non-interactive commands and then uses them to clear the queue.

**Do:**
1. Extend `scripts/admin-submissions.ts`:
   - `inspect <id>` — read-only. Prints OCR pre-fill, Claude's confidence, signed photo URLs, and a duplicate check against `products.barcode`. Must NOT mutate `user_submissions.status`.
   - `publish <id>` — non-interactive. Uses `publishExtracted` with `reviewedBy = ADMIN_USER_IDS[0]`. Must accept both `pending` and `in_review` input statuses (one of the 8 is already `in_review`).
2. For each of the 8 rows:
   - `inspect <id>` to read state
   - Duplicate barcode → `reject <id> duplicate_barcode`
   - OCR bad → `reject <id> ocr_failed`
   - Clean → `publish <id>`
3. Summary note (≤15 lines): how many of the 8 would have auto-published under threshold 85, confidence distribution (min/median/max), any systemic OCR failures, recommended threshold.

**Acceptance:**
- [ ] All 8 submissions dispositioned
- [ ] `admin:submissions` lists zero pending rows
- [ ] Summary note committed to [docs/](.) or linked in Slack

---

### Task B — Fix the three supplement-submission gaps

**Estimate:** ~1 hour. **Blockers:** None.

**Do:**

1. **Scan cache branch.** In [app/api/products/scan/[barcode]/route.ts](../app/api/products/scan/[barcode]/route.ts) at the cache-hit block (around line 146), remove the `if (row.scoreBreakdown)` gate. Serve the cached product when `cachedIngredients.length > 0`, regardless of score state. When `scoreBreakdown` is null, return `score: null` in the `ScanResult` (the type already permits this).

2. **Search filter.** In [app/api/products/search/route.ts](../app/api/products/search/route.ts) around line 82, add `isNotNull(products.score)` to the where conditions array. Matches [suggestions/route.ts:89](../app/api/products/search/suggestions/route.ts#L89).

3. **Kill switch.** In [lib/submissions/auto-publish.ts](../lib/submissions/auto-publish.ts), at the top of `tryAutoPublish`, add:
   ```ts
   if (process.env.AUTO_PUBLISH_ENABLED === 'false') {
     return { kind: 'skipped', reason: 'disabled' };
   }
   ```
   Extend the `AutoPublishResult['skipped']['reason']` union with `'disabled'`.

4. **Expo client pending-score state.** In cucumberdude, find the scan-result product card. When `scanResult.score === null`, render a badge and copy: *"Score pending — we'll rate this when supplement scoring ships."* Don't render the alternatives block. Don't crash on null score (verify the existing renderer handles it).

**Acceptance:**
- [ ] Unit/integration test: submitting a supplement barcode then scanning it returns the product, not 404
- [ ] `curl POST /api/products/search` with a query that would match a null-scored product returns zero rows
- [ ] Setting `AUTO_PUBLISH_ENABLED=false` causes `tryAutoPublish` to skip with `reason: 'disabled'`
- [ ] Scanning a null-scored product in the Expo client renders the pending state without errors

---

### Task C — Preview deploy + e2e (grooming + supplement)

**Estimate:** ~45 minutes. **Blockers:** Tasks A + B.

**Do:**
1. Commit Tasks A + B as one PR. Review. Merge.
2. `vercel env add AUTO_PUBLISH_ENABLED` — set to `true` in development, preview, production
3. `vercel env add AUTH_ENABLED preview` — set to `true` (the only remaining bit from old Task 4)
4. `vercel` — preview deploy (not `--prod`)
5. **Grooming e2e:** submit barcode `8718951594883` with front+back photos against the preview URL. Expect `{ status: 'auto_published', product_id: ... }` or `{ status: 'pending_review' }`. Never a 500.
6. **Supplement e2e:** submit a real supplement barcode (operator picks one — any protein powder / multivitamin from their shelf works). Expect auto-publish to succeed with `score: null`. Then GET `/api/products/scan/<barcode>` and expect `200` with `score: null` — not 404.
7. **Kill switch toggle:** set `AUTO_PUBLISH_ENABLED=false` on preview, submit a different test barcode, confirm `{ status: 'pending_review' }` regardless of confidence. Restore to `true`.
8. **Auth header check:** while logs are tailing, confirm incoming requests carry `Authorization: Bearer`. If not, stop and investigate before Task E.

**Acceptance:**
- [ ] Both e2e submissions succeed without 500s
- [ ] Supplement submission: subsequent scan returns the product with `score: null`, not 404
- [ ] Kill switch toggle visibly changes behavior
- [ ] `Authorization: Bearer` seen in logs on real client requests
- [ ] Preview URL logged for Task E

---

### Task D — Manual QA pass

**Estimate:** ~30 minutes. **Blockers:** Task C.

**Do:**
1. Pick three Poor grooming products (`score < 40`). For each, `GET /api/products/<id>/alternatives` and note:
   - ≥1 alternative returned
   - Same subcategory as the scanned product
   - ≥15 points higher
   - Common-sense check (no cross-subcategory nonsense)
2. `GET /api/recommendations` after scanning 3–5 grooming products in a session. Verify the pairs make sense against the ~413-product grooming pool.
3. Scan the Task C test supplement barcode. Verify the Expo client renders the pending-score state without crashing and without offering alternatives.
4. `POST /api/products/search` with query `"protein"`. Verify zero null-scored supplements in the response.
5. Pass/fail QA note committed to `docs/`.

**Acceptance:**
- [ ] Three Poor grooming products tested
- [ ] Recommendations render a sensible pair
- [ ] Supplement pending state renders cleanly
- [ ] Search does not leak null-scored rows
- [ ] QA note exists

**Not in scope:** fixing anything found. File issues, don't fix in this task.

---

### Task E — Production promotion + real-device dogfood

**Estimate:** ~20 minutes. **Blockers:** Tasks C + D.

**Do:**
1. Promote the Task C preview to production.
2. Within 5 minutes: on a real Expo device (not simulator), scan a grooming product against production. Confirm score renders.
3. On the same device, scan a supplement barcode that's now in the catalog (from Task C). Confirm the pending-score state renders.
4. Tail `vercel logs` for 10 minutes. If >5% of requests return 401, immediately flip `AUTH_ENABLED=false` on production and investigate.
5. Scan an unknown supplement barcode on the device. Confirm the submission flow runs and the product becomes visible on a rescan.

**Acceptance:**
- [ ] Production scan works on real hardware
- [ ] Supplement pending state works on real hardware
- [ ] Unknown-barcode submission → persist → rescan path works on real hardware
- [ ] No sustained 401 spike

---

### Task F — Docs refresh

**Estimate:** ~20 minutes. **Blockers:** None (can run in parallel with any other task).

**Do:**
1. Update [docs/status.md](./status.md): reflect rev 4 reality — M3.0/M3.1 shipped, auth shipped, supplements deferred. Remove any remaining S3 references that didn't get caught in commit `fd8bda4`.
2. Confirm [docs/post-mvp/supplement-scoring.md](./post-mvp/supplement-scoring.md) exists (created alongside this plan). Link it from status.md under "Deferred."
3. (Historical: `docs/roadmap.md` was removed in favor of `docs/status.md` as the single milestone-status source of truth.)

**Acceptance:**
- [ ] `docs/status.md` reflects shipped milestones and deferred supplements
- [ ] Supplement scoring doc is linked from status.md

---

## Sequencing

```
Hour 1: Task A (CLI helpers + triage) — foreground
        Task F (docs refresh) — background, any spare cycles

Hour 2: Task B (three code fixes) — foreground
        Task F wraps up if not already done

Hour 3: Task C (preview deploy + e2e) — foreground
        Task D (manual QA) — runs immediately after C, same session

Hour 4: Task E (prod promotion + real-device dogfood) — foreground
        Buffer for anything filed during D
```

Total critical path: **~4 hours.** Single-engineer doable.

---

## Deliberately not doing this sprint

| Item | Why |
|---|---|
| Phase A rescore re-run | Already ran. Yielded zero net scores. Supplement stub is the binding constraint. |
| Phase B refetch of 401 OBF grooming orphans | Cosmetic metric fix. User submissions pipeline fills density where users actually scan. |
| Subcategory backfill second pass | Ran once (366 → 244). Remaining 244 are LLM undetermined cases; re-running won't help. Will get reclassified organically via future submissions. |
| Supplement scoring logic | Deferred to M2. See [docs/post-mvp/supplement-scoring.md](./post-mvp/supplement-scoring.md). |
| Food scoring expansion | We have 2 food products. Not worth the effort until the catalog grows. |
| Search tsvector / GIN index | 1,417 rows. ILIKE handles this. Revisit at 10k+. |
| Designer polish of search/browse UI | Hold until supplements land — otherwise we re-design it twice. |
| Admin web dashboard | Triggered at 20 submissions/week. Currently <10 total. |
| Rate limiting on submit | File-size + MIME checks in place. Add when abuse appears. |
| Photo retention policy | Keep forever per PM. Storage cost line added to monthly review after launch. |

---

## Deliberately deferred features (scheduled)

| Feature | Doc | Rough scope |
|---|---|---|
| Supplement scoring (M2) | [docs/post-mvp/supplement-scoring.md](./post-mvp/supplement-scoring.md) | Scoring model + retroactive rescoring pass + client messaging removal |
| On-device auto-crop for submissions (M3.2) | [docs/milestones/m3-user-submissions.md](./milestones/m3-user-submissions.md) | 4 weeks post-launch |
| Commercial provider fallback (M5) | [docs/status.md](./status.md#m5--commercial-fallback) | Revisit if unknown-barcode drop-off is measurable |
| Pomenatal brand onboarding | [docs/multi-brand-migration.md](./multi-brand-migration.md) | Markers already in code (commit `fd8bda4`) |
| Product recalls (backend + push) | — | Soften client permission copy is done; infra deferred |
| Admin web dashboard | — | Trigger: 20 submissions/week |

---

## Risks

1. **Claude Vision supplement extraction is untested.** The OCR path has never been exercised on a DSLD-style supplement facts label (vitamin/mineral rows, % daily value, etc.). Task C's supplement e2e is the first real test. If it fails catastrophically, the auto-publish confidence gate will keep things safe, and the CLI admin path is available as fallback.
2. **Auto-publish confidence threshold (85) is tuned on grooming images.** It may be wrong for supplements. Task A's triage gives empirical data; threshold tuning is a follow-up, not a blocker.
3. **Search now excludes null-scored products universally.** If auto-publish fails on a grooming submission for some reason, that product exists but is invisible in search. Acceptable tradeoff — scan still returns it. Revisit if it becomes a user complaint.

---

## References

- [docs/post-mvp/supplement-scoring.md](./post-mvp/supplement-scoring.md) — what M2 needs
- [docs/status.md](./status.md) — shipped milestones
- [docs/milestones/m3-user-submissions.md](./milestones/m3-user-submissions.md) — M3.0/M3.1 pipeline (shipped)
- [docs/multi-brand-migration.md](./multi-brand-migration.md) — future Pomenatal onboarding sketch
- [CLAUDE.md](../CLAUDE.md) — codebase conventions
- [cucumberdude/lib/api.ts](../../cucumberdude/lib/api.ts) — client API contract

---

## Answered history

### rev 4 (2026-04-11)
- Supplements in MVP → **no; deferred to M2**
- Catalog densification (Phase B refetch) → **skip; user submissions handle density**
- Plan simplified from 10 tasks to 6 (A–F)
- Added three verified code gaps that block "users can submit supplements" — all one-liner fixes
- Removed the "90% scored" target entirely (it was never honest under the supplement stub)

### rev 3 (2026-04-11)
- Multi-brand scope → **Mangood only today; Pomenatal reuses this infra later** (Task 9 shipped as TODO markers in commit `fd8bda4`)
- `/api/products/:barcode/score` → **dead code in client, no backend work** (Task 9 repurposed)
- Recalls in permission copy → **softened in cucumberdude** (App Store 5.1.1 risk; 30-second fix, shipped)
- Search tab default category → **keep "grooming"**
- Task 1 production sign-off → **gated on Task D QA + Task E real-device check**

### rev 2 (2026-04-11)
- Auth in MVP → **yes** (shipped in commit `fd8bda4`)
- Coverage target → originally 90% scored; **dropped in rev 4** as dishonest under the supplement stub
- Subcategory filter in search → **yes** (shipped)
- Designer in-sprint → **deferred** in rev 4 (hold until supplements land)
- 8 pending submissions → **publish non-duplicates, reject duplicates** (Task A)
- Photo retention → **keep forever**
- Admin dashboard trigger → **20 submissions/week**
- Auto-publish rollback story → **env-var kill switch** (Task B)
- Expo client auth header → **already sends `Authorization: Bearer <jwt>`** in production
- Search endpoint verb → **POST** (shipped)

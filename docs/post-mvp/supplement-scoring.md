# Supplement Scoring — Deferred to Post-MVP (M2)

**Status:** Not in MVP. Scheduled for the sprint immediately after launch.
**Decision date:** 2026-04-11 (see [docs/mvp-sprint-plan.md](../mvp-sprint-plan.md) rev 4)
**Affects:** 603 of 1,417 products in the current catalog (~43%). All supplements.

---

## Why it was deferred

1. **The ingredient-position-deduction model is wrong for supplements.** Food and grooming are scored by "how early does a bad ingredient appear in the ingredients list, and how severe is it." This is a defensible heuristic for foods and cosmetics where ingredients are listed in descending quantity order. **Supplements are not that.** A good supplement can have 30 ingredients, most of which are vitamins at precise doses. A bad supplement can have 3 ingredients, one of which is a banned stimulant. Position in the list carries essentially no information. Running the grooming scorer against supplement ingredient lists would produce scores that look authoritative but are meaningless — the worst possible failure mode for a safety product.

2. **Shipping a stub model under time pressure is worse than shipping no score.** The charter requirement is *"unknown ingredients resolve to neutral."* Extending that principle, unknown scoring logic should resolve to "no score, and tell the user honestly that we don't know yet." That's what rev 4 of the sprint plan does — supplements persist with `score: null` and the client renders a "Score pending" state.

3. **The catalog-entry path for supplements is user submissions, not seed scripts.** DSLD is indexed by label ID, not barcode, so there's no way to resolve an unknown supplement barcode to a DSLD row at scan time. OFF and OBF don't carry supplements. This means the *only* way supplements enter the catalog at runtime is the user-submissions pipeline. Shipping supplement scoring before that pipeline is proven is putting the cart before the horse.

4. **Supplements need life-stage semantics that grooming doesn't have.** For Mangood's current life stages (testosterone optimization, athletic performance, longevity focus), an ingredient like DHEA is relevant in ways it isn't for a deodorant. For the future Pomenatal brand (pregnancy/postpartum), many supplements are outright contraindicated. The multiplier logic in [lib/scoring/constants.ts](../../lib/scoring/constants.ts) is not structured for this yet.

---

## What works in MVP for supplements

Rev 4 of the sprint plan establishes the minimum viable supplement path:

- **Scanning a known supplement.** The scan endpoint returns the product with `score: null`. The Expo client renders a "Score pending" badge and the product identity (name, brand, image, ingredients). No score, no alternatives, no personalization — but the user knows we have the product.
- **Scanning an unknown supplement.** The scan endpoint returns `404 { capture: true }`, which triggers the submission flow in the Expo client. Claude Vision extracts name, brand, ingredients, category. `upsertProduct` writes a row with `source: 'user'`, `score: null`. Subsequent scans return state 1.
- **Submitting a supplement explicitly.** Same path as above, without waiting for a 404.
- **Persistence.** Every submitted supplement is stored permanently in `products` + `product_ingredients`. When supplement scoring ships, a retroactive rescore pass will score all of them at once.

## What does NOT work in MVP for supplements

- **Scoring.** Obvious.
- **Search / suggestions / browse.** Supplements are excluded server-side via `score IS NOT NULL` filters on `/api/products/search` and `/api/products/search/suggestions`. The Expo search tab defaults to the grooming category. Supplements never appear in any list.
- **Alternatives.** [app/api/products/[id]/alternatives/route.ts](../../app/api/products/[id]/alternatives/route.ts) requires `scoreBreakdown IS NOT NULL` on candidates, so supplements are naturally excluded.
- **Recommendations.** Same — the recommendations engine filters on scored products.
- **Life-stage personalization.** No scores means no multipliers to apply.

This is not an accident — it's the point. The only surface where a supplement appears for an MVP user is a direct barcode scan, where the pending state is unambiguous.

---

## What shipping supplement scoring requires

Rough M2 scope. Each bullet is a rough order of magnitude, not a commitment.

### 1. Scoring model (the hard part — 2–4 days of engineering + design)

Three candidate approaches, not mutually exclusive:

**A. Heuristic by dose + ingredient dictionary.**
For each ingredient, compare the declared dose (from the Supplement Facts panel) against a literature-derived "safe adult dose range." Score is a function of (a) how many ingredients fall inside/outside the safe range and (b) flagged ingredients from the dictionary (banned stimulants, etc.). Requires a structured dose parser for DSLD labels and a curated dose reference table.

**B. Human-curated product scores for the top N.**
Score the 50–200 most-scanned supplements manually. Ship a read-only "curated score" path that beats any algorithm for popular products. Long tail falls through to approach A or C.

**C. LLM-assisted scoring.**
Send the ingredient list + doses + claims to Claude with a rubric. Cache the result. Good for coverage; acceptable for latency if cached. Risk: hallucination on obscure ingredients. Mitigation: constrain output schema, require the rubric to cite the ingredient dictionary for any flag.

**Recommendation.** Start with B (50 products) for the launch-day safety net. Add A as the default long-tail scorer. Keep C as an experimental fallback for completeness — do not block launch on C.

Where this lives: [lib/scoring/supplement.ts](../../lib/scoring/supplement.ts) (new file). [lib/scoring/index.ts:40](../../lib/scoring/index.ts#L40) currently returns `null` for `category === 'supplement'` — that's the single line to flip.

### 2. Retroactive rescore pass (half a day)

Once the scorer is live, run a one-off script that selects `WHERE category = 'supplement' AND score IS NULL` and scores each one. [scripts/rescore-products.ts](../../scripts/rescore-products.ts) already exists and handles this shape — it just skips supplements today. Remove the `category === 'supplement'` skip and the existing script becomes the M2 backfill tool.

Expected yield at M2 time: all supplements currently in the catalog (603 today, likely more by then if user submissions land), plus any that accumulated between MVP launch and M2.

### 3. Client messaging reversal (half a day)

In the Expo client (cucumberdude):
- Remove the "Score pending" badge component.
- Include supplements in the search tab category dropdown.
- Un-hide supplements from browse/suggestions defaults.
- Update the submission flow success copy — currently will say something like "added, score coming later"; should just confirm the add and let the score render.

Server side:
- Remove `isNotNull(products.score)` from `/api/products/search` if you want supplements in search. (Keep it for suggestions if we want to avoid showing a handful of stubborn null-scored rows mid-backfill.)
- No other API change — the wire format has supported nullable scores all along.

### 4. Life-stage multipliers for supplements (half a day for Mangood, more for Pomenatal)

[LIFE_STAGE_MULTIPLIERS](../../lib/scoring/constants.ts) is tuned for grooming and food. Extend (or fork per category) for supplements. This is small for Mangood's life stages and larger for Pomenatal when that brand onboards — but Pomenatal is a separate sprint anyway (see [docs/multi-brand-migration.md](../multi-brand-migration.md)).

### 5. Monitoring

- Add a `score IS NULL BY category` row to [scripts/db-coverage.ts](../../scripts/db-coverage.ts) so we can watch the supplement backlog drain after launch.
- Alert if user submissions introduce a flagged ingredient (e.g., a banned stimulant) that's not yet in the dictionary — catches new market entrants before they sit unscored for days.

### 6. Testing

- Unit tests for the supplement scorer against ~10 representative DSLD labels (pre-workout, multivitamin, protein powder, fish oil, probiotic, etc.)
- Manual QA pass matching the MVP Task D shape, but against supplements.

### Rough total

~1 week of engineering for a first version, assuming approach B (curated) + A (heuristic) and no Pomenatal work. Add 2–3 days if approach C (LLM) is in the first cut.

---

## What NOT to do when M2 lands

1. **Don't re-run DSLD ingestion.** It already ran and produced the 603 rows we have. Re-running gets no new data.
2. **Don't switch data sources.** DSLD is fine for MVP. Commercial providers (Nutritionix, etc.) are M5 territory.
3. **Don't ship approach C alone.** An LLM scorer with no human-curated baseline or deterministic heuristic is unauditable.
4. **Don't remove the `Score pending` state without the retroactive rescore pass running first.** Otherwise existing user submissions will suddenly become invisible in a different way.

---

## Linked artifacts

- [lib/scoring/index.ts:40](../../lib/scoring/index.ts#L40) — current null return for supplements; the single line M2 flips
- [scripts/rescore-products.ts](../../scripts/rescore-products.ts) — reused as the M2 backfill tool
- [lib/scoring/constants.ts](../../lib/scoring/constants.ts) — life-stage multipliers, needs supplement-specific extension
- [lib/dictionary/seed.ts](../../lib/dictionary/seed.ts) — current dictionary, will need supplement-specific entries (dose metadata)
- [docs/mvp-sprint-plan.md](../mvp-sprint-plan.md) — rev 4 where this deferral was decided
- [docs/multi-brand-migration.md](../multi-brand-migration.md) — Pomenatal onboarding sketch; supplement scoring is a prerequisite for that brand

# Multi-brand migration sketch

**Status:** Not started · planning sketch only
**Trigger:** Pomenatal onboarding sprint (date TBD)
**Related:** Multi-brand markers already shipped in cucumberdude (brand configs, BrandContext, white-label architecture)

---

## Current state

`guardscan-api` is **Mangood-only** today. The Expo client (`cucumberdude`)
is already white-label and supports both Mangood and Pomenatal via
`brands/*.ts` configs, but the backend makes several Mangood-specific
assumptions that will need brand-scoping when Pomenatal onboards. None of
those assumptions are blockers for the MVP launch — the point of this doc
is to make them findable with one `grep`.

```bash
grep -rn "TODO(multi-brand)" .
```

Returns the four files listed below (plus this doc itself).

---

## What needs to change

| File | Mangood-specific assumption | Likely fix |
|---|---|---|
| [types/guardscan.ts](../types/guardscan.ts) (`LifeStage`) | Enum is men's-health only (`testosterone_optimization`, `actively_trying_to_conceive`, `athletic_performance`, `longevity_focus`, `general_wellness`). No pregnancy / postpartum / nursing variants. | Extend the enum with Pomenatal values, or split into a brand-scoped discriminated type. Client already needs matching values — coordinate with cucumberdude. |
| [lib/scoring/constants.ts](../lib/scoring/constants.ts) (`LIFE_STAGE_MULTIPLIERS`) | Multipliers are keyed to the Mangood `LifeStage` type. Some ingredients neutral for adult men are dangerous during pregnancy (retinoids, high-dose vitamin A, isotretinoin, certain essential oils). | Pass a brand-scoped multiplier map into `scoreProduct()` instead of reading the global constant. Brand is known at request time — either via auth profile, JWT claim, or an `X-Brand` header. |
| [lib/dictionary/seed.ts](../lib/dictionary/seed.ts) | The 147 curated entries are biased toward men's health priorities (fertility, testosterone, grooming). Pregnancy needs stricter flags for ingredients currently marked `neutral` (retinol, salicylic acid >2%, soy isoflavones, high-caffeine). | Load brand-scoped seed subsets at ingest time, or — cleaner — move the dictionary to per-brand DB rows and query by brand. |
| [lib/llm/classifier.ts](../lib/llm/classifier.ts) + [lib/subcategory.ts](../lib/subcategory.ts) (`SUBCATEGORY_HINTS`) | Vocabulary has no anchor words for `prenatal_vitamin`, `maternal_snack`, `nursing_balm`, `postpartum_supplement`, etc. Pomenatal products will miss-classify. | Add brand-scoped entries to `SUBCATEGORY_HINTS` or pass a per-brand vocabulary into the classifier prompt. The classifier's confidence validation already coerces unknowns to null, so this won't silently corrupt existing Mangood data. |

---

## Suggested approach

**Do not** introduce a brand parameter retroactively into every function
signature. That breaks the scoring module's "pure function" contract and
creates a thread-through problem for every call site.

**Do** introduce a single brand-scoped config object resolved at request
entry (route handler, CLI entrypoint, ingest cron) and pass it into the
seams that currently read global constants:

```ts
// Shape sketch — not a contract
type BrandConfig = {
  brand: 'mangood' | 'pomenatal';
  lifeStages: readonly LifeStage[];
  lifeStageMultipliers: Record<LifeStage, number>;
  dictionaryScope: 'mangood' | 'pomenatal';  // or a set of table rows
  subcategoryVocabulary: readonly string[];
};
```

Resolution order for a given request:

1. Explicit header/claim (`X-Brand: pomenatal` or `brand` in the JWT)
2. Inferred from the authenticated user's profile (`profiles.brand`)
3. Default: `mangood` (preserves current behavior for all existing code paths)

Once the config object exists, migrating each of the four files is
mechanical: replace the global constant read with a parameter read.

---

## Schema changes that will eventually be needed

Not this sprint, but worth noting so the future sprint doesn't discover
them under pressure:

- `products.brand_scope` text column — which brand(s) this product is
  relevant for. Default `'mangood'` on backfill; dual-brand products
  (e.g. a multivitamin) may need a future `brand_scope[]` array or a
  join table.
- `user_submissions.brand_scope` text column — captured at submit time
  from the client's active brand config.
- `profiles.brand` text column — needed for the request-time resolution
  described above. Today every profile is implicitly Mangood.
- `ingredient_dictionary.brand_scope` — if we move the seed to DB rows.

---

## Schema changes we're explicitly NOT doing now

- No brand column on any existing row. Backfill would be trivial but
  it's wasted work until there's a Pomenatal launch date.
- No brand-scoped rate limiting or auth pool split. Both brands can
  share one Supabase project until a concrete privacy/legal need forces
  separation.
- No brand-scoped API URL. The client already namespaces by
  `EXPO_PUBLIC_API_URL` per build profile, but both brands can point
  at the same deployment.

---

## Non-goals for this doc

- This is **not** a detailed implementation plan. It's a sketch that
  makes the future refactor findable and roughly shaped.
- This is **not** a commitment to any specific Pomenatal launch date.
- This **not** pre-work to run now. Every line of code under a
  `TODO(multi-brand)` marker should stay as-is until the Pomenatal
  onboarding sprint.

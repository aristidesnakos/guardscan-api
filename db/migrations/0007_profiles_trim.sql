-- Profiles trim (2026-05-13)
-- Onboarding rebuilt to 3 steps: primary concern (life_stage) → take supplements → age.
-- Drops fields that had ZERO scoring consumers and zero non-profile reads:
--   - trying_to_conceive  → redundant with life_stage = 'actively_trying_to_conceive'
--   - allergens           → food-allergens column, irrelevant for grooming-first MVP
--   - dietary_approach    → food-app residue, premature for supplements milestone
-- Adds:
--   - takes_supplements   → gates supplements scanner UX (M6) + demographic signal
--
-- Rationale: scan behavior already surfaces sensitivities, brand affinity, and
-- category focus. Onboarding only earns its keep for fields behavior won't
-- infer. life_stage drives scoring multiplier; takes_supplements gates a
-- future feature; age is one tap and never inferable.
--
-- DEPLOY ORDER (atomic; small user base, still beta):
--   1. Apply this migration
--   2. Deploy backend with updated schema.ts + route.ts + types
--   3. Deploy frontend (already references the new shape)
--
-- ROLLBACK: see bottom of file.

BEGIN;

ALTER TABLE profiles
  ADD COLUMN takes_supplements BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE profiles DROP COLUMN trying_to_conceive;
ALTER TABLE profiles DROP COLUMN allergens;
ALTER TABLE profiles DROP COLUMN dietary_approach;

COMMIT;

-- ── Rollback ───────────────────────────────────────────────────────────────
-- BEGIN;
-- ALTER TABLE profiles
--   ADD COLUMN trying_to_conceive BOOLEAN NOT NULL DEFAULT false,
--   ADD COLUMN allergens          TEXT[]  NOT NULL DEFAULT '{}',
--   ADD COLUMN dietary_approach   TEXT    NOT NULL DEFAULT 'standard';
-- ALTER TABLE profiles DROP COLUMN takes_supplements;
-- COMMIT;

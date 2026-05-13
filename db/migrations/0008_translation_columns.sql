-- Translation backfill — durable storage columns (2026-05-13)
--
-- Catalog has ~9.5% non-English product names from OBF community contributions
-- (FR/IT/DE/NL/PT). User contract: products.name is US English. Daily OBF delta
-- cron clobbers any translation within 24h via ON CONFLICT DO UPDATE SET name.
--
-- These columns claim a row for our translation pipeline so the cron preserves
-- the English name instead of overwriting it:
--
--   original_name        — source-language value at time of translation
--   source_language      — ISO-639-1 of original_name (fr, it, de, nl, pt, …)
--   translation_status   — claim flag for upsert logic + outbox state:
--                            NULL       row untouched by translation
--                            'auto'     LLM-translated, may be re-translated
--                            'manual'   human-edited, NEVER overwrite
--                            'pending'  flagged for next translation cycle
--                            'failed'   prior attempt errored, retry-eligible
--                            'disputed' user flagged via report — needs review
--
-- See lib/cron/ingest-helpers.ts upsertProduct: Phase 2 of this work updates
-- onConflictDoUpdate to respect these columns. Without that code change, this
-- migration alone is inert.
--
-- DEPLOY ORDER:
--   1. Apply this migration (additive, no downtime)
--   2. Deploy backend with updated upsertProduct claim logic + round-trip test
--   3. Wait one OBF cron cycle (0 3 * * * UTC) — verify no regressions
--   4. Run backfill script (scripts/translate-names.ts --apply)
--
-- ROLLBACK: see bottom.

BEGIN;

ALTER TABLE products
  ADD COLUMN original_name        TEXT,
  ADD COLUMN source_language      TEXT,
  ADD COLUMN translation_status   TEXT;

ALTER TABLE products
  ADD CONSTRAINT products_translation_status_check
  CHECK (translation_status IS NULL OR translation_status IN (
    'auto', 'manual', 'pending', 'failed', 'disputed'
  ));

-- Partial index — only rows participating in translation pipeline.
-- Drives outbox scans (pending/failed) and disputed-row reviews.
CREATE INDEX products_translation_status_idx
  ON products (translation_status)
  WHERE translation_status IS NOT NULL;

COMMIT;

-- ── Rollback ───────────────────────────────────────────────────────────────
-- BEGIN;
-- DROP INDEX IF EXISTS products_translation_status_idx;
-- ALTER TABLE products DROP CONSTRAINT IF EXISTS products_translation_status_check;
-- ALTER TABLE products
--   DROP COLUMN IF EXISTS translation_status,
--   DROP COLUMN IF EXISTS source_language,
--   DROP COLUMN IF EXISTS original_name;
-- COMMIT;

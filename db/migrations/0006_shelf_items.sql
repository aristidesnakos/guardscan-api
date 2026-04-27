-- Shelf items table (2026-04-27)
-- Manual, user-curated collection of products in active use.
-- Replaces the Recs tab as the primary retention asset on the Expo client.
--
-- Spec: cucumberdude/docs/product/FEATURES/SHELF.md
--
-- Key semantics:
--   * One product = one shelf entry per user (UNIQUE on user_id, product_id).
--     Re-scans never duplicate; they just bump scan_date via the server-side
--     scan hook (TBD wire-up in /api/scans/record).
--   * scan_date auto-updates on every barcode scan whose product_id is already
--     on the user's shelf — handled in the scan endpoint, not via PUT.
--     The "Update Shelf" button on the Expo client is informational only.
--   * swapped_from_id is set explicitly via the post-add swap prompt
--     (Flow 4 in the spec). When the user picks a replacement target, the
--     DELETE /api/shelf/:id call atomically deletes the old row and sets
--     swapped_from_id on the new row. ON DELETE SET NULL on the FK so we
--     keep the swap label even if the swapped-out product later disappears
--     from the catalog.
--   * upgrades_available is computed at GET time, not stored. Pair only
--     counts when item.score IS NOT NULL AND ∃ alternative in same category
--     with a strictly higher non-null score. Resilient to ~57% null-score
--     coverage as of 2026-04-27.
--
-- Denormalized columns (product_name, product_brand, product_category,
-- current_score) follow the spec verbatim. Trade-off: stale on rescore /
-- product update, but per-user shelves are bounded (target ~10–25 items)
-- so a future job or trigger can refresh cheaply. Revisit if drift bites.
--
-- user_id is TEXT to match scan_events / user_submissions / profiles
-- (Supabase auth.users.id).
--
-- product_category is TEXT (not a CHECK enum) — keeps it editable from
-- the client without a migration if taxonomy expands. Validated in app code.

CREATE TABLE IF NOT EXISTS shelf_items (
  id                 UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            TEXT        NOT NULL,
  product_id         UUID        NOT NULL REFERENCES products(id) ON DELETE CASCADE,

  -- Shelf-specific metadata
  added_date         TIMESTAMPTZ NOT NULL DEFAULT now(),
  scan_date          TIMESTAMPTZ NOT NULL DEFAULT now(),
  swapped_from_id    UUID        REFERENCES products(id) ON DELETE SET NULL,

  -- Denormalized snapshot of the product at add-time (refresh on rescore)
  product_name       TEXT        NOT NULL,
  product_brand      TEXT,
  product_category   TEXT        NOT NULL,
  current_score      SMALLINT,

  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT shelf_items_user_product_unique UNIQUE (user_id, product_id)
);

-- Recent-first sort on the populated shelf view
CREATE INDEX IF NOT EXISTS shelf_items_user_scan_date_idx
  ON shelf_items (user_id, scan_date DESC);

-- Category filter (All / Grooming / Supplements tabs)
CREATE INDEX IF NOT EXISTS shelf_items_user_category_idx
  ON shelf_items (user_id, product_category);

-- Fast scan-hook lookup: "is this product on the user's shelf?"
-- Covered by the UNIQUE constraint above (Postgres builds an index for it).

-- ── RLS ───────────────────────────────────────────────────────────────────────
-- Pattern: owner read/insert/update/delete + service-role full access.
-- user_id is TEXT matching auth.uid()::text (same as scan_events).

ALTER TABLE "shelf_items" ENABLE ROW LEVEL SECURITY;

-- authenticated: own rows only

CREATE POLICY "shelf_items_select_own"
  ON "shelf_items" FOR SELECT
  TO authenticated
  USING (auth.uid()::text = user_id);

CREATE POLICY "shelf_items_insert_own"
  ON "shelf_items" FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid()::text = user_id);

CREATE POLICY "shelf_items_update_own"
  ON "shelf_items" FOR UPDATE
  TO authenticated
  USING (auth.uid()::text = user_id)
  WITH CHECK (auth.uid()::text = user_id);

CREATE POLICY "shelf_items_delete_own"
  ON "shelf_items" FOR DELETE
  TO authenticated
  USING (auth.uid()::text = user_id);

-- service_role: full access

CREATE POLICY "shelf_items_service_select"
  ON "shelf_items" FOR SELECT
  TO service_role
  USING (true);

CREATE POLICY "shelf_items_service_insert"
  ON "shelf_items" FOR INSERT
  TO service_role
  WITH CHECK (true);

CREATE POLICY "shelf_items_service_update"
  ON "shelf_items" FOR UPDATE
  TO service_role
  USING (true)
  WITH CHECK (true);

CREATE POLICY "shelf_items_service_delete"
  ON "shelf_items" FOR DELETE
  TO service_role
  USING (true);

-- Initial RLS policy setup for all tables.
-- Consolidated from the original 0001_rls_policies.sql and 0002_rls_cron_scan_events.sql.
--
-- Run order for a fresh database:
--   0000_tan_wendigo      → tables (products, product_ingredients, ingredient_dictionary, user_submissions)
--   0001_damp_piledriver  → tables (cron_state, scan_events) + indexes
--   0002_policies         ← this file
--   0003_m3_tweaks        → M3 schema changes + policy updates

-- ── Enable RLS ───────────────────────────────────────────────────────────────

ALTER TABLE "products"              ENABLE ROW LEVEL SECURITY;
ALTER TABLE "product_ingredients"   ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ingredient_dictionary" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "user_submissions"      ENABLE ROW LEVEL SECURITY;
ALTER TABLE "cron_state"            ENABLE ROW LEVEL SECURITY;
ALTER TABLE "scan_events"           ENABLE ROW LEVEL SECURITY;

-- ── products (public read, service-role write) ───────────────────────────────

CREATE POLICY "products_select_all"
  ON "products" FOR SELECT
  TO anon, authenticated
  USING (true);

CREATE POLICY "products_service_insert"
  ON "products" FOR INSERT
  TO service_role
  WITH CHECK (true);

CREATE POLICY "products_service_update"
  ON "products" FOR UPDATE
  TO service_role
  USING (true)
  WITH CHECK (true);

CREATE POLICY "products_service_delete"
  ON "products" FOR DELETE
  TO service_role
  USING (true);

-- ── product_ingredients (public read, service-role write) ────────────────────

CREATE POLICY "product_ingredients_select_all"
  ON "product_ingredients" FOR SELECT
  TO anon, authenticated
  USING (true);

CREATE POLICY "product_ingredients_service_insert"
  ON "product_ingredients" FOR INSERT
  TO service_role
  WITH CHECK (true);

CREATE POLICY "product_ingredients_service_update"
  ON "product_ingredients" FOR UPDATE
  TO service_role
  USING (true)
  WITH CHECK (true);

CREATE POLICY "product_ingredients_service_delete"
  ON "product_ingredients" FOR DELETE
  TO service_role
  USING (true);

-- ── ingredient_dictionary (public read, service-role write) ──────────────────

CREATE POLICY "ingredient_dictionary_select_all"
  ON "ingredient_dictionary" FOR SELECT
  TO anon, authenticated
  USING (true);

CREATE POLICY "ingredient_dictionary_service_insert"
  ON "ingredient_dictionary" FOR INSERT
  TO service_role
  WITH CHECK (true);

CREATE POLICY "ingredient_dictionary_service_update"
  ON "ingredient_dictionary" FOR UPDATE
  TO service_role
  USING (true)
  WITH CHECK (true);

CREATE POLICY "ingredient_dictionary_service_delete"
  ON "ingredient_dictionary" FOR DELETE
  TO service_role
  USING (true);

-- ── user_submissions (owner read/insert, service-role full access) ───────────
-- Note: user_id is uuid at this point in the sequence.
-- 0003_m3_tweaks migrates it to text and updates these two owner policies.

CREATE POLICY "user_submissions_select_own"
  ON "user_submissions" FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

CREATE POLICY "user_submissions_insert_own"
  ON "user_submissions" FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "user_submissions_service_select"
  ON "user_submissions" FOR SELECT
  TO service_role
  USING (true);

CREATE POLICY "user_submissions_service_insert"
  ON "user_submissions" FOR INSERT
  TO service_role
  WITH CHECK (true);

CREATE POLICY "user_submissions_service_update"
  ON "user_submissions" FOR UPDATE
  TO service_role
  USING (true)
  WITH CHECK (true);

CREATE POLICY "user_submissions_service_delete"
  ON "user_submissions" FOR DELETE
  TO service_role
  USING (true);

-- ── cron_state (service-role only) ───────────────────────────────────────────

CREATE POLICY "cron_state_select_service"
  ON "cron_state" FOR SELECT
  TO service_role
  USING (true);

CREATE POLICY "cron_state_insert_service"
  ON "cron_state" FOR INSERT
  TO service_role
  WITH CHECK (true);

CREATE POLICY "cron_state_update_service"
  ON "cron_state" FOR UPDATE
  TO service_role
  USING (true)
  WITH CHECK (true);

CREATE POLICY "cron_state_delete_service"
  ON "cron_state" FOR DELETE
  TO service_role
  USING (true);

-- ── scan_events (owner read/insert, service-role full access) ────────────────

CREATE POLICY "scan_events_select_own"
  ON "scan_events" FOR SELECT
  TO authenticated
  USING (auth.uid()::text = user_id);

CREATE POLICY "scan_events_insert_own"
  ON "scan_events" FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid()::text = user_id);

CREATE POLICY "scan_events_service_select"
  ON "scan_events" FOR SELECT
  TO service_role
  USING (true);

CREATE POLICY "scan_events_service_insert"
  ON "scan_events" FOR INSERT
  TO service_role
  WITH CHECK (true);

CREATE POLICY "scan_events_service_update"
  ON "scan_events" FOR UPDATE
  TO service_role
  USING (true)
  WITH CHECK (true);

CREATE POLICY "scan_events_service_delete"
  ON "scan_events" FOR DELETE
  TO service_role
  USING (true);

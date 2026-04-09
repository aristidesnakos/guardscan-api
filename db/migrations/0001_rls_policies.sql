-- Enable RLS on all tables
ALTER TABLE "products" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "product_ingredients" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ingredient_dictionary" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "user_submissions" ENABLE ROW LEVEL SECURITY;

-- ── products (public read, service-role write) ──────────────────────────────

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

-- ── product_ingredients (public read, service-role write) ───────────────────

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

-- ── ingredient_dictionary (public read, service-role write) ─────────────────

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

-- ── user_submissions (owner read/insert, service-role full access) ──────────

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

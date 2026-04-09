-- Enable RLS on new tables
ALTER TABLE "cron_state" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "scan_events" ENABLE ROW LEVEL SECURITY;

-- ── cron_state (service-role only) ────────────────────────────────────────

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

-- ── scan_events (owner read/insert, service-role full access) ─────────────

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

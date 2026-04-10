-- M3.0: Fix user_id type mismatch (uuid → text to match scan_events.user_id and auth return type)
--       Add reviewed_by to track manual vs auto-publish without polluting the status enum.
ALTER TABLE user_submissions
  ALTER COLUMN user_id TYPE text USING user_id::text,
  ADD COLUMN IF NOT EXISTS reviewed_by text;

-- M3.0: Create private Supabase Storage bucket for submission photos.
--       Supabase exposes bucket management through the storage schema.
--       ON CONFLICT DO NOTHING makes this idempotent — safe to re-run.
INSERT INTO storage.buckets (id, name, public)
VALUES ('submissions', 'submissions', false)
ON CONFLICT (id) DO NOTHING;

-- User profiles table (2026-04-23)
-- Single source of truth for all user state that needs server-side persistence:
--   health profile, subscription status, scan count, onboarding flag.
--
-- user_id matches Supabase auth.users.id (text, consistent with scan_events
-- and user_submissions which also store user_id as TEXT).
--
-- scan_count replaces the proposed standalone user_scan_counts table.
-- subscription_tier synced via RevenueCat webhook (POST /api/webhooks/revenuecat).

CREATE TABLE IF NOT EXISTS profiles (
  user_id                 TEXT        NOT NULL PRIMARY KEY,

  -- Health profile (mirrors UserProfile type in types/guardscan.ts)
  age                     SMALLINT,
  life_stage              TEXT        NOT NULL DEFAULT 'general_wellness',
  trying_to_conceive      BOOLEAN     NOT NULL DEFAULT false,
  allergens               TEXT[]      NOT NULL DEFAULT '{}',
  dietary_approach        TEXT        NOT NULL DEFAULT 'standard',

  -- Subscription
  subscription_tier       TEXT        NOT NULL DEFAULT 'free',
  revenuecat_customer_id  TEXT,

  -- Freemium gate
  scan_count              INTEGER     NOT NULL DEFAULT 0,

  -- Onboarding
  onboarding_complete     BOOLEAN     NOT NULL DEFAULT false,

  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

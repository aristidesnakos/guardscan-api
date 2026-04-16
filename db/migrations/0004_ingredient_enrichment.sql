-- Phase 1 ingredient enrichment (2026-04-16)
-- Adds ingredient family grouping and hazard tags to ingredient_dictionary.
-- Description and evidence_sources columns are deferred to Phase 3.
--
-- health_risk_tags controlled vocabulary:
--   irritant | endocrine_disruptor | carcinogen | allergen |
--   organ_toxicant | environmental | gut_disruptor | reproductive_toxin

ALTER TABLE ingredient_dictionary
  ADD COLUMN IF NOT EXISTS ingredient_group TEXT,
  ADD COLUMN IF NOT EXISTS health_risk_tags TEXT[] DEFAULT '{}';

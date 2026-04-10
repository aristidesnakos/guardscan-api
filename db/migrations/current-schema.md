-- WARNING: This schema is for context only and is not meant to be run.
-- Table order and constraints may not be valid for execution.

CREATE TABLE public.cron_state (
  job_name text NOT NULL,
  last_processed_key text,
  last_run_at timestamp with time zone,
  last_run_status text,
  metadata jsonb,
  CONSTRAINT cron_state_pkey PRIMARY KEY (job_name)
);
CREATE TABLE public.ingredient_dictionary (
  normalized text NOT NULL,
  display_name text NOT NULL,
  flag text NOT NULL,
  category text,
  evidence_url text,
  notes text,
  fertility_relevant boolean NOT NULL DEFAULT false,
  testosterone_relevant boolean NOT NULL DEFAULT false,
  CONSTRAINT ingredient_dictionary_pkey PRIMARY KEY (normalized)
);
CREATE TABLE public.product_ingredients (
  product_id uuid NOT NULL,
  position integer NOT NULL,
  name text NOT NULL,
  normalized text NOT NULL,
  flag text,
  reason text,
  CONSTRAINT product_ingredients_pkey PRIMARY KEY (product_id, position),
  CONSTRAINT product_ingredients_product_id_products_id_fk FOREIGN KEY (product_id) REFERENCES public.products(id)
);
CREATE TABLE public.products (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  barcode text NOT NULL UNIQUE,
  name text NOT NULL,
  brand text,
  category text NOT NULL,
  subcategory text,
  image_front text,
  image_ingredients text,
  image_nutrition text,
  raw_ingredients text,
  source text NOT NULL,
  source_id text,
  score smallint,
  score_breakdown jsonb,
  last_synced_at timestamp with time zone NOT NULL DEFAULT now(),
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT products_pkey PRIMARY KEY (id)
);
CREATE TABLE public.scan_events (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  user_id text NOT NULL,
  product_id uuid NOT NULL,
  scanned_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT scan_events_pkey PRIMARY KEY (id),
  CONSTRAINT scan_events_product_id_products_id_fk FOREIGN KEY (product_id) REFERENCES public.products(id)
);
CREATE TABLE public.user_submissions (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  barcode text NOT NULL,
  photos jsonb NOT NULL,
  ocr_text text,
  status text NOT NULL DEFAULT 'pending'::text,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT user_submissions_pkey PRIMARY KEY (id)
);
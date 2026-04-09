CREATE TABLE IF NOT EXISTS "cron_state" (
	"job_name" text PRIMARY KEY NOT NULL,
	"last_processed_key" text,
	"last_run_at" timestamp with time zone,
	"last_run_status" text,
	"metadata" jsonb
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "scan_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"product_id" uuid NOT NULL,
	"scanned_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "scan_events" ADD CONSTRAINT "scan_events_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "scan_events_user_product_idx" ON "scan_events" USING btree ("user_id","product_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "scan_events_user_scanned_at_idx" ON "scan_events" USING btree ("user_id","scanned_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "products_subcategory_score_idx" ON "products" USING btree ("subcategory","score");
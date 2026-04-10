CREATE TABLE IF NOT EXISTS "ingredient_dictionary" (
	"normalized" text PRIMARY KEY NOT NULL,
	"display_name" text NOT NULL,
	"flag" text NOT NULL,
	"category" text,
	"evidence_url" text,
	"notes" text,
	"fertility_relevant" boolean DEFAULT false NOT NULL,
	"testosterone_relevant" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "product_ingredients" (
	"product_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"name" text NOT NULL,
	"normalized" text NOT NULL,
	"flag" text,
	"reason" text,
	CONSTRAINT "product_ingredients_product_id_position_pk" PRIMARY KEY("product_id","position")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "products" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"barcode" text NOT NULL,
	"name" text NOT NULL,
	"brand" text,
	"category" text NOT NULL,
	"subcategory" text,
	"image_front" text,
	"image_ingredients" text,
	"image_nutrition" text,
	"raw_ingredients" text,
	"source" text NOT NULL,
	"source_id" text,
	"score" smallint,
	"score_breakdown" jsonb,
	"last_synced_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "products_barcode_unique" UNIQUE("barcode")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "user_submissions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"barcode" text NOT NULL,
	"photos" jsonb NOT NULL,
	"ocr_text" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "product_ingredients" ADD CONSTRAINT "product_ingredients_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "products_category_score_idx" ON "products" USING btree ("category","score");
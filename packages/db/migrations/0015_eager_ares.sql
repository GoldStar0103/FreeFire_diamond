CREATE TYPE "public"."rocketpass_item_kind" AS ENUM('gift', 'membership');--> statement-breakpoint
ALTER TYPE "public"."item_fulfillment_status" ADD VALUE 'cancelled';--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "item_catalog" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sku" text NOT NULL,
	"display_name" text NOT NULL,
	"rocketpass_name" text NOT NULL,
	"kind" "rocketpass_item_kind" NOT NULL,
	"price_ars" numeric(12, 2) NOT NULL,
	"max_quantity" integer NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"rocketpass_available" boolean DEFAULT true NOT NULL,
	"last_synced_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "item_catalog_sku_unique" UNIQUE("sku")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "item_stock" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"item_catalog_id" uuid NOT NULL,
	"region" text NOT NULL,
	"quantity" integer NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "item_stock" ADD CONSTRAINT "item_stock_item_catalog_id_item_catalog_id_fk" FOREIGN KEY ("item_catalog_id") REFERENCES "public"."item_catalog"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "item_stock_item_region_idx" ON "item_stock" USING btree ("item_catalog_id","region");
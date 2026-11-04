CREATE TYPE "public"."provider_name" AS ENUM('recargas_america', 'central_one');--> statement-breakpoint
DROP INDEX IF EXISTS "base_products_provider_id_idx";--> statement-breakpoint
ALTER TABLE "base_products" ADD COLUMN "provider" "provider_name" DEFAULT 'recargas_america' NOT NULL;--> statement-breakpoint
ALTER TABLE "order_items" ADD COLUMN "provider" "provider_name" DEFAULT 'recargas_america' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "base_products_provider_id_idx" ON "base_products" USING btree ("provider","provider_product_id");
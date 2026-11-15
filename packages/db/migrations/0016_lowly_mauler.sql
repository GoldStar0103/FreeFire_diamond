ALTER TABLE "item_order_details" ALTER COLUMN "region" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "item_order_details" ADD COLUMN "attempt_count" integer DEFAULT 0 NOT NULL;
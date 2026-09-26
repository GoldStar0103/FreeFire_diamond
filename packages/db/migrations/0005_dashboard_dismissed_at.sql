ALTER TABLE "order_items" ADD COLUMN "dashboard_dismissed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "dashboard_dismissed_at" timestamp with time zone;
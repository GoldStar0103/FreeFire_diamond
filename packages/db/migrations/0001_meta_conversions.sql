ALTER TABLE "orders" ADD COLUMN "capi_sent_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "capi_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "orders_capi_pending_idx" ON "orders" USING btree ("paid_at") WHERE capi_sent_at IS NULL;
ALTER TYPE "public"."ledger_entry_type" ADD VALUE 'order_refund';--> statement-breakpoint
ALTER TYPE "public"."order_status" ADD VALUE 'refunded';--> statement-breakpoint
ALTER TABLE "level_pass_lp_transactions" ADD COLUMN "diamonds" integer;--> statement-breakpoint
ALTER TABLE "level_pass_lp_transactions" ADD COLUMN "ranking_diamonds" integer;--> statement-breakpoint
ALTER TABLE "level_pass_lp_transactions" ADD COLUMN "reversed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "level_pass_lp_transactions" ADD COLUMN "reversed_by_admin_id" uuid;--> statement-breakpoint
ALTER TABLE "level_pass_lp_transactions" ADD COLUMN "reversal_reason" text;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "level_pass_lp_transactions" ADD CONSTRAINT "lp_lp_tx_reversed_admin_fk" FOREIGN KEY ("reversed_by_admin_id") REFERENCES "public"."admin_users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

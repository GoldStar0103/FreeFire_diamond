CREATE TYPE "public"."item_fulfillment_status" AS ENUM('pending', 'processing', 'delivered', 'partial', 'failed', 'awaiting_stock');--> statement-breakpoint
CREATE TYPE "public"."notification_type" AS ENUM('order_created', 'order_expiring', 'order_expired', 'payment_confirmed', 'order_delivered', 'order_failed', 'late_payment_delivered', 'awaiting_stock', 'refund', 'tickets_earned');--> statement-breakpoint
CREATE TYPE "public"."order_type" AS ENUM('diamonds', 'item');--> statement-breakpoint
CREATE TYPE "public"."ticket_transaction_type" AS ENUM('purchase', 'entry', 'return', 'reversal', 'admin_adjustment');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "item_order_details" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"item_sku" text NOT NULL,
	"item_name_snapshot" text NOT NULL,
	"quantity" integer DEFAULT 1 NOT NULL,
	"region" text NOT NULL,
	"unit_price_snapshot_cents" integer NOT NULL,
	"rocketpass_order_id" text,
	"fulfillment_status" "item_fulfillment_status" DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"player_profile_id" uuid NOT NULL,
	"type" "notification_type" NOT NULL,
	"title" text NOT NULL,
	"message" text NOT NULL,
	"target_url" text,
	"order_id" uuid,
	"read_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "ticket_transactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"player_profile_id" uuid NOT NULL,
	"type" "ticket_transaction_type" NOT NULL,
	"amount" integer NOT NULL,
	"resulting_balance" integer NOT NULL,
	"order_id" uuid,
	"admin_id" uuid,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "orders" ALTER COLUMN "combo_key" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "order_type" "order_type" DEFAULT 'diamonds' NOT NULL;--> statement-breakpoint
ALTER TABLE "player_profiles" ADD COLUMN "ticket_balance" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "item_order_details" ADD CONSTRAINT "item_order_details_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "notifications" ADD CONSTRAINT "notifications_player_profile_id_player_profiles_id_fk" FOREIGN KEY ("player_profile_id") REFERENCES "public"."player_profiles"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "notifications" ADD CONSTRAINT "notifications_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "ticket_transactions" ADD CONSTRAINT "ticket_transactions_player_profile_id_player_profiles_id_fk" FOREIGN KEY ("player_profile_id") REFERENCES "public"."player_profiles"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "ticket_transactions" ADD CONSTRAINT "ticket_transactions_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "ticket_transactions" ADD CONSTRAINT "ticket_transactions_admin_id_admin_users_id_fk" FOREIGN KEY ("admin_id") REFERENCES "public"."admin_users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "item_order_details_order_idx" ON "item_order_details" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "notifications_player_unread_idx" ON "notifications" USING btree ("player_profile_id","read_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "notifications_player_created_idx" ON "notifications" USING btree ("player_profile_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ticket_tx_player_idx" ON "ticket_transactions" USING btree ("player_profile_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "ticket_tx_order_type_idx" ON "ticket_transactions" USING btree ("order_id","type");
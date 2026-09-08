CREATE TYPE "public"."endpoint_kind" AS ENUM('games', 'pins_recharge', 'pins_code');--> statement-breakpoint
CREATE TYPE "public"."order_item_status" AS ENUM('queued', 'sending', 'succeeded', 'failed', 'unknown', 'provider_pending');--> statement-breakpoint
CREATE TYPE "public"."order_status" AS ENUM('pending_payment', 'payment_confirmed', 'processing', 'partially_delivered', 'completed', 'payment_expired', 'needs_review', 'refund_required', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."payment_method" AS ENUM('transfer_manual', 'spei', 'oxxo', 'card', 'paypal');--> statement-breakpoint
CREATE TYPE "public"."payment_status" AS ENUM('pending', 'under_review', 'paid', 'expired', 'failed', 'amount_mismatch');--> statement-breakpoint
CREATE TYPE "public"."resolution_source" AS ENUM('response', 'wallet_delta', 'polling', 'manual');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "admin_users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"password_hash" text NOT NULL,
	"totp_secret" text,
	"name" text,
	"role" text DEFAULT 'operator' NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "audit_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"admin_user_id" uuid,
	"action" text NOT NULL,
	"entity_type" text,
	"entity_id" text,
	"detail" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "base_products" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider_product_id" text NOT NULL,
	"endpoint_kind" "endpoint_kind" NOT NULL,
	"sku" text,
	"name" text NOT NULL,
	"diamonds_base" integer NOT NULL,
	"bonus_pct" integer DEFAULT 10 NOT NULL,
	"cost_usd" numeric(12, 4),
	"requires_server_id" boolean DEFAULT false NOT NULL,
	"can_validate" boolean DEFAULT false NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"last_synced_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "campaigns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"flyer_asset_url" text,
	"badge" text,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"permanent" boolean DEFAULT false NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"starts_at" timestamp with time zone,
	"ends_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "combo_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"combo_id" uuid NOT NULL,
	"base_product_id" uuid NOT NULL,
	"sequence" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "combos" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"campaign_id" uuid NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"price_mxn_cents" integer NOT NULL,
	"advertised_diamonds" integer NOT NULL,
	"max_per_player" integer,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"starts_at" timestamp with time zone,
	"ends_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "order_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"sequence" integer NOT NULL,
	"base_product_id" uuid,
	"provider_product_id" text NOT NULL,
	"diamonds_base" integer NOT NULL,
	"status" "order_item_status" DEFAULT 'queued' NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"provider_transaction_id" text,
	"provider_reference" text,
	"request_payload" jsonb,
	"response_payload" jsonb,
	"http_status" integer,
	"error_code" text,
	"wallet_before_usd" numeric(12, 4),
	"wallet_after_usd" numeric(12, 4),
	"cost_usd" numeric(12, 4),
	"resolved_by" "resolution_source",
	"sent_at" timestamp with time zone,
	"settled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_number" text NOT NULL,
	"player_id" text NOT NULL,
	"player_nickname" text,
	"server_id" text,
	"contact_email" text,
	"contact_whatsapp" text,
	"combo_id" uuid,
	"combo_key" text NOT NULL,
	"combo_snapshot" jsonb NOT NULL,
	"price_mxn_cents" integer NOT NULL,
	"status" "order_status" DEFAULT 'pending_payment' NOT NULL,
	"event_id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"fbp" text,
	"fbc" text,
	"client_ip" text,
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"paid_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "payment_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"gateway" text NOT NULL,
	"gateway_event_id" text NOT NULL,
	"event_type" text,
	"payment_id" uuid,
	"payload" jsonb NOT NULL,
	"processed_at" timestamp with time zone,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"method" "payment_method" NOT NULL,
	"status" "payment_status" DEFAULT 'pending' NOT NULL,
	"gateway" text,
	"gateway_charge_id" text,
	"amount_expected_cents" integer NOT NULL,
	"amount_received_cents" integer,
	"clabe" text,
	"reference" text,
	"comprobante_asset_url" text,
	"reviewed_by_admin_id" uuid,
	"expires_at" timestamp with time zone,
	"paid_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "provider_api_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_item_id" uuid,
	"method" text NOT NULL,
	"path" text NOT NULL,
	"request_payload" jsonb,
	"response_payload" jsonb,
	"http_status" integer,
	"duration_ms" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "wallet_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"balance_usd" numeric(12, 4) NOT NULL,
	"currency" text DEFAULT 'USD' NOT NULL,
	"taken_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_admin_user_id_admin_users_id_fk" FOREIGN KEY ("admin_user_id") REFERENCES "public"."admin_users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "combo_items" ADD CONSTRAINT "combo_items_combo_id_combos_id_fk" FOREIGN KEY ("combo_id") REFERENCES "public"."combos"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "combo_items" ADD CONSTRAINT "combo_items_base_product_id_base_products_id_fk" FOREIGN KEY ("base_product_id") REFERENCES "public"."base_products"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "combos" ADD CONSTRAINT "combos_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "order_items" ADD CONSTRAINT "order_items_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "order_items" ADD CONSTRAINT "order_items_base_product_id_base_products_id_fk" FOREIGN KEY ("base_product_id") REFERENCES "public"."base_products"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "orders" ADD CONSTRAINT "orders_combo_id_combos_id_fk" FOREIGN KEY ("combo_id") REFERENCES "public"."combos"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "payment_events" ADD CONSTRAINT "payment_events_payment_id_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "payments" ADD CONSTRAINT "payments_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "provider_api_log" ADD CONSTRAINT "provider_api_log_order_item_id_order_items_id_fk" FOREIGN KEY ("order_item_id") REFERENCES "public"."order_items"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "admin_users_email_idx" ON "admin_users" USING btree ("email");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "audit_log_created_idx" ON "audit_log" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "base_products_provider_id_idx" ON "base_products" USING btree ("provider_product_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "campaigns_key_idx" ON "campaigns" USING btree ("key");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "combo_items_seq_idx" ON "combo_items" USING btree ("combo_id","sequence");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "combos_key_idx" ON "combos" USING btree ("key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "combos_campaign_idx" ON "combos" USING btree ("campaign_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "order_items_seq_idx" ON "order_items" USING btree ("order_id","sequence");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "order_items_status_idx" ON "order_items" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "orders_number_idx" ON "orders" USING btree ("order_number");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "orders_player_idx" ON "orders" USING btree ("player_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "orders_status_idx" ON "orders" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "one_mega_oferta_per_player" ON "orders" USING btree ("player_id") WHERE combo_key = 'mega_10' AND status NOT IN ('cancelled', 'payment_expired');--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "payment_events_gateway_id_idx" ON "payment_events" USING btree ("gateway","gateway_event_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "payments_order_idx" ON "payments" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "payments_status_idx" ON "payments" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "provider_api_log_created_idx" ON "provider_api_log" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "wallet_snapshots_taken_idx" ON "wallet_snapshots" USING btree ("taken_at");
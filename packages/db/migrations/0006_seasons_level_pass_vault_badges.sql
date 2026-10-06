CREATE TYPE "public"."award_source" AS ENUM('automatic', 'manual');--> statement-breakpoint
CREATE TYPE "public"."badge_category" AS ENUM('ranking', 'level_pass', 'special', 'event');--> statement-breakpoint
CREATE TYPE "public"."badge_rarity" AS ENUM('common', 'rare', 'epic', 'legendary', 'exclusive');--> statement-breakpoint
CREATE TYPE "public"."ledger_entry_type" AS ENUM('level_pass_reward', 'manual_expense', 'manual_income');--> statement-breakpoint
CREATE TYPE "public"."reward_status" AS ENUM('pending', 'granted', 'reversed');--> statement-breakpoint
CREATE TYPE "public"."season_status" AS ENUM('active', 'closed');--> statement-breakpoint
CREATE TYPE "public"."vault_status" AS ENUM('active', 'expired');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "badge_definitions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"badge_key" text NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"category" "badge_category" NOT NULL,
	"rarity" "badge_rarity" DEFAULT 'common' NOT NULL,
	"artwork_asset_url" text,
	"season_scoped" boolean DEFAULT false NOT NULL,
	"eligibility_starts_at" timestamp with time zone,
	"eligibility_ends_at" timestamp with time zone,
	"obtainable" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "badge_ownerships" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"player_profile_id" uuid NOT NULL,
	"badge_definition_id" uuid NOT NULL,
	"season_id" uuid,
	"achievement_data" jsonb,
	"source" "award_source" DEFAULT 'automatic' NOT NULL,
	"awarded_by_admin_id" uuid,
	"reason" text,
	"earned_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "featured_badges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"player_profile_id" uuid NOT NULL,
	"badge_ownership_id" uuid NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "financial_ledger_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"entry_type" "ledger_entry_type" NOT NULL,
	"amount_cents" integer NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"season_id" uuid,
	"source_type" text,
	"source_id" uuid,
	"note" text,
	"created_by_admin_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "hall_of_fame_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"season_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"player_profile_id" uuid NOT NULL,
	"display_name_snapshot" text,
	"avatar_asset_url_snapshot" text,
	"seasonal_diamonds" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "level_pass_checkpoint_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"season_id" uuid NOT NULL,
	"player_profile_id" uuid NOT NULL,
	"checkpoint_lp" integer NOT NULL,
	"reward_diamonds" integer NOT NULL,
	"internal_cost_cents" integer NOT NULL,
	"status" "reward_status" DEFAULT 'pending' NOT NULL,
	"source" "award_source" DEFAULT 'automatic' NOT NULL,
	"related_order_id" uuid,
	"reason" text,
	"reached_at" timestamp with time zone DEFAULT now() NOT NULL,
	"granted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "level_pass_lp_transactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"season_id" uuid NOT NULL,
	"player_profile_id" uuid NOT NULL,
	"sale_amount_cents" integer NOT NULL,
	"product_cost_cents" integer NOT NULL,
	"payment_fee_cents" integer NOT NULL,
	"estimated_profit_cents" integer NOT NULL,
	"calculated_lp" integer NOT NULL,
	"awarded_lp" integer NOT NULL,
	"overridden_by_admin_id" uuid,
	"override_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "player_otp_codes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"whatsapp" text NOT NULL,
	"code_hash" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "player_profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"player_id" text NOT NULL,
	"whatsapp" text NOT NULL,
	"display_name" text,
	"avatar_asset_url" text,
	"lifetime_diamonds_purchased" integer DEFAULT 0 NOT NULL,
	"lifetime_recharge_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "season_player_stats" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"season_id" uuid NOT NULL,
	"player_profile_id" uuid NOT NULL,
	"lp" integer DEFAULT 0 NOT NULL,
	"seasonal_diamonds" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "seasons" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"season_number" integer NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"status" "season_status" DEFAULT 'active' NOT NULL,
	"closed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "vault_entitlements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"season_id" uuid NOT NULL,
	"player_profile_id" uuid NOT NULL,
	"status" "vault_status" DEFAULT 'active' NOT NULL,
	"unlocked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "vault_offers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"combo_id" uuid NOT NULL,
	"vault_price_mxn_cents" integer NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "badge_ownerships" ADD CONSTRAINT "badge_ownerships_player_profile_id_player_profiles_id_fk" FOREIGN KEY ("player_profile_id") REFERENCES "public"."player_profiles"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "badge_ownerships" ADD CONSTRAINT "badge_ownerships_badge_definition_id_badge_definitions_id_fk" FOREIGN KEY ("badge_definition_id") REFERENCES "public"."badge_definitions"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "badge_ownerships" ADD CONSTRAINT "badge_ownerships_season_id_seasons_id_fk" FOREIGN KEY ("season_id") REFERENCES "public"."seasons"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "badge_ownerships" ADD CONSTRAINT "badge_ownerships_awarded_by_admin_id_admin_users_id_fk" FOREIGN KEY ("awarded_by_admin_id") REFERENCES "public"."admin_users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "featured_badges" ADD CONSTRAINT "featured_badges_player_profile_id_player_profiles_id_fk" FOREIGN KEY ("player_profile_id") REFERENCES "public"."player_profiles"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "featured_badges" ADD CONSTRAINT "featured_badges_badge_ownership_id_badge_ownerships_id_fk" FOREIGN KEY ("badge_ownership_id") REFERENCES "public"."badge_ownerships"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "financial_ledger_entries" ADD CONSTRAINT "financial_ledger_entries_season_id_seasons_id_fk" FOREIGN KEY ("season_id") REFERENCES "public"."seasons"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "financial_ledger_entries" ADD CONSTRAINT "financial_ledger_entries_created_by_admin_id_admin_users_id_fk" FOREIGN KEY ("created_by_admin_id") REFERENCES "public"."admin_users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "hall_of_fame_entries" ADD CONSTRAINT "hall_of_fame_entries_season_id_seasons_id_fk" FOREIGN KEY ("season_id") REFERENCES "public"."seasons"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "hall_of_fame_entries" ADD CONSTRAINT "hall_of_fame_entries_player_profile_id_player_profiles_id_fk" FOREIGN KEY ("player_profile_id") REFERENCES "public"."player_profiles"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "level_pass_checkpoint_events" ADD CONSTRAINT "level_pass_checkpoint_events_season_id_seasons_id_fk" FOREIGN KEY ("season_id") REFERENCES "public"."seasons"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "level_pass_checkpoint_events" ADD CONSTRAINT "level_pass_checkpoint_events_related_order_id_orders_id_fk" FOREIGN KEY ("related_order_id") REFERENCES "public"."orders"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "level_pass_checkpoint_events" ADD CONSTRAINT "lp_checkpoint_events_profile_fk" FOREIGN KEY ("player_profile_id") REFERENCES "public"."player_profiles"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "level_pass_lp_transactions" ADD CONSTRAINT "level_pass_lp_transactions_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "level_pass_lp_transactions" ADD CONSTRAINT "level_pass_lp_transactions_season_id_seasons_id_fk" FOREIGN KEY ("season_id") REFERENCES "public"."seasons"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "level_pass_lp_transactions" ADD CONSTRAINT "lp_lp_tx_profile_fk" FOREIGN KEY ("player_profile_id") REFERENCES "public"."player_profiles"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "level_pass_lp_transactions" ADD CONSTRAINT "lp_lp_tx_overridden_admin_fk" FOREIGN KEY ("overridden_by_admin_id") REFERENCES "public"."admin_users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "season_player_stats" ADD CONSTRAINT "season_player_stats_season_id_seasons_id_fk" FOREIGN KEY ("season_id") REFERENCES "public"."seasons"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "season_player_stats" ADD CONSTRAINT "season_player_stats_player_profile_id_player_profiles_id_fk" FOREIGN KEY ("player_profile_id") REFERENCES "public"."player_profiles"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "vault_entitlements" ADD CONSTRAINT "vault_entitlements_season_id_seasons_id_fk" FOREIGN KEY ("season_id") REFERENCES "public"."seasons"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "vault_entitlements" ADD CONSTRAINT "vault_entitlements_player_profile_id_player_profiles_id_fk" FOREIGN KEY ("player_profile_id") REFERENCES "public"."player_profiles"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "vault_offers" ADD CONSTRAINT "vault_offers_combo_id_combos_id_fk" FOREIGN KEY ("combo_id") REFERENCES "public"."combos"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "badge_definitions_key_idx" ON "badge_definitions" USING btree ("badge_key");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "badge_ownerships_seasonal_unique_idx" ON "badge_ownerships" USING btree ("player_profile_id","badge_definition_id","season_id") WHERE season_id IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "badge_ownerships_evergreen_unique_idx" ON "badge_ownerships" USING btree ("player_profile_id","badge_definition_id") WHERE season_id IS NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "badge_ownerships_player_idx" ON "badge_ownerships" USING btree ("player_profile_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "featured_badges_unique_idx" ON "featured_badges" USING btree ("player_profile_id","badge_ownership_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "financial_ledger_occurred_idx" ON "financial_ledger_entries" USING btree ("occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "hall_of_fame_unique_idx" ON "hall_of_fame_entries" USING btree ("season_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "level_pass_checkpoint_unique_idx" ON "level_pass_checkpoint_events" USING btree ("season_id","player_profile_id","checkpoint_lp");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "level_pass_lp_tx_order_idx" ON "level_pass_lp_transactions" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "level_pass_lp_tx_player_season_idx" ON "level_pass_lp_transactions" USING btree ("player_profile_id","season_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "player_otp_codes_whatsapp_idx" ON "player_otp_codes" USING btree ("whatsapp");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "player_profiles_player_id_idx" ON "player_profiles" USING btree ("player_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "player_profiles_whatsapp_idx" ON "player_profiles" USING btree ("whatsapp");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "player_profiles_display_name_idx" ON "player_profiles" USING btree ("display_name") WHERE display_name IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "season_player_stats_unique_idx" ON "season_player_stats" USING btree ("season_id","player_profile_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "season_player_stats_ranking_idx" ON "season_player_stats" USING btree ("season_id","seasonal_diamonds");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "seasons_number_idx" ON "seasons" USING btree ("season_number");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "vault_entitlements_unique_idx" ON "vault_entitlements" USING btree ("season_id","player_profile_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "vault_offers_combo_idx" ON "vault_offers" USING btree ("combo_id");
CREATE TYPE "public"."giveaway_prize_type" AS ENUM('manual', 'diamonds');--> statement-breakpoint
CREATE TYPE "public"."giveaway_winner_delivery_status" AS ENUM('pending', 'delivered', 'failed');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "giveaway_winners" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"giveaway_id" uuid NOT NULL,
	"player_profile_id" uuid NOT NULL,
	"free_fire_id" text NOT NULL,
	"position" integer NOT NULL,
	"cost_cents_snapshot" integer NOT NULL,
	"delivery_status" "giveaway_winner_delivery_status" DEFAULT 'pending' NOT NULL,
	"delivery_order_id" uuid,
	"delivery_note" text,
	"delivered_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "giveaway_entries" ADD COLUMN "free_fire_id" text;--> statement-breakpoint
ALTER TABLE "giveaway_entries" ADD COLUMN "free_fire_nickname" text;--> statement-breakpoint
ALTER TABLE "giveaways" ADD COLUMN "winner_count" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "giveaways" ADD COLUMN "prize_type" "giveaway_prize_type" DEFAULT 'manual' NOT NULL;--> statement-breakpoint
ALTER TABLE "giveaways" ADD COLUMN "prize_diamonds" integer;--> statement-breakpoint
ALTER TABLE "giveaways" ADD COLUMN "prize_recipe" jsonb;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "giveaway_winners" ADD CONSTRAINT "giveaway_winners_giveaway_id_giveaways_id_fk" FOREIGN KEY ("giveaway_id") REFERENCES "public"."giveaways"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "giveaway_winners" ADD CONSTRAINT "giveaway_winners_player_profile_id_player_profiles_id_fk" FOREIGN KEY ("player_profile_id") REFERENCES "public"."player_profiles"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "giveaway_winners" ADD CONSTRAINT "giveaway_winners_delivery_order_id_orders_id_fk" FOREIGN KEY ("delivery_order_id") REFERENCES "public"."orders"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "giveaway_winners_giveaway_player_idx" ON "giveaway_winners" USING btree ("giveaway_id","player_profile_id");
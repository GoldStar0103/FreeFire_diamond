CREATE TYPE "public"."giveaway_schedule_type" AS ENUM('daily', 'weekly', 'monthly', 'flash');--> statement-breakpoint
CREATE TYPE "public"."giveaway_status" AS ENUM('draft', 'open', 'closed_pending_draw', 'drawn', 'delivered', 'cancelled');--> statement-breakpoint
ALTER TYPE "public"."notification_type" ADD VALUE 'giveaway_won';--> statement-breakpoint
ALTER TYPE "public"."notification_type" ADD VALUE 'giveaway_cancelled';--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "giveaway_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"giveaway_id" uuid NOT NULL,
	"player_profile_id" uuid NOT NULL,
	"entry_count" integer NOT NULL,
	"tickets_spent" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "giveaways" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"title" text NOT NULL,
	"description" text NOT NULL,
	"prize_description" text NOT NULL,
	"entry_cost_tickets" integer NOT NULL,
	"schedule_type" "giveaway_schedule_type" NOT NULL,
	"min_entries" integer DEFAULT 0 NOT NULL,
	"opens_at" timestamp with time zone NOT NULL,
	"closes_at" timestamp with time zone NOT NULL,
	"status" "giveaway_status" DEFAULT 'draft' NOT NULL,
	"winner_player_profile_id" uuid,
	"drawn_at" timestamp with time zone,
	"drawn_by_admin_id" uuid,
	"cancel_reason" text,
	"created_by_admin_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ticket_transactions" ADD COLUMN "giveaway_id" uuid;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "giveaway_entries" ADD CONSTRAINT "giveaway_entries_giveaway_id_giveaways_id_fk" FOREIGN KEY ("giveaway_id") REFERENCES "public"."giveaways"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "giveaway_entries" ADD CONSTRAINT "giveaway_entries_player_profile_id_player_profiles_id_fk" FOREIGN KEY ("player_profile_id") REFERENCES "public"."player_profiles"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "giveaways" ADD CONSTRAINT "giveaways_winner_player_profile_id_player_profiles_id_fk" FOREIGN KEY ("winner_player_profile_id") REFERENCES "public"."player_profiles"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "giveaways" ADD CONSTRAINT "giveaways_drawn_by_admin_id_admin_users_id_fk" FOREIGN KEY ("drawn_by_admin_id") REFERENCES "public"."admin_users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "giveaways" ADD CONSTRAINT "giveaways_created_by_admin_id_admin_users_id_fk" FOREIGN KEY ("created_by_admin_id") REFERENCES "public"."admin_users"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "giveaway_entries_giveaway_player_idx" ON "giveaway_entries" USING btree ("giveaway_id","player_profile_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "giveaways_status_closes_idx" ON "giveaways" USING btree ("status","closes_at");--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "ticket_transactions" ADD CONSTRAINT "ticket_transactions_giveaway_id_giveaways_id_fk" FOREIGN KEY ("giveaway_id") REFERENCES "public"."giveaways"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

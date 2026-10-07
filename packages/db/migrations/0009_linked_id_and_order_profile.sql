ALTER TABLE "orders" ADD COLUMN "player_profile_id" uuid;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_player_profile_id_player_profiles_id_fk" FOREIGN KEY ("player_profile_id") REFERENCES "public"."player_profiles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "orders_player_profile_idx" ON "orders" USING btree ("player_profile_id");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "player_linked_id_changes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"player_profile_id" uuid NOT NULL,
	"season_id" uuid NOT NULL,
	"from_player_id" text NOT NULL,
	"to_player_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
ALTER TABLE "player_linked_id_changes" ADD CONSTRAINT "player_linked_id_changes_player_profile_id_player_profiles_id_fk" FOREIGN KEY ("player_profile_id") REFERENCES "public"."player_profiles"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "player_linked_id_changes" ADD CONSTRAINT "player_linked_id_changes_season_id_seasons_id_fk" FOREIGN KEY ("season_id") REFERENCES "public"."seasons"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "player_linked_id_changes_once_per_season_idx" ON "player_linked_id_changes" USING btree ("player_profile_id","season_id");

ALTER TABLE "giveaways" DROP CONSTRAINT "giveaways_winner_player_profile_id_player_profiles_id_fk";
--> statement-breakpoint
ALTER TABLE "giveaways" DROP COLUMN IF EXISTS "winner_player_profile_id";
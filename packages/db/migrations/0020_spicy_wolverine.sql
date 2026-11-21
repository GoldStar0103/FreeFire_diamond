ALTER TYPE "public"."ledger_entry_type" ADD VALUE 'giveaway_prize';--> statement-breakpoint
ALTER TABLE "giveaways" ADD COLUMN "prize_value_cents" integer;
ALTER TABLE "player_profiles" RENAME COLUMN "whatsapp" TO "email";--> statement-breakpoint
ALTER TABLE "player_otp_codes" RENAME COLUMN "whatsapp" TO "email";--> statement-breakpoint
ALTER INDEX "player_profiles_whatsapp_idx" RENAME TO "player_profiles_email_idx";--> statement-breakpoint
ALTER INDEX "player_otp_codes_whatsapp_idx" RENAME TO "player_otp_codes_email_idx";

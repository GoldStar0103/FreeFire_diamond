ALTER TABLE "level_pass_checkpoint_events" ADD COLUMN "reward_order_id" uuid;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "level_pass_checkpoint_events" ADD CONSTRAINT "level_pass_checkpoint_events_reward_order_id_orders_id_fk" FOREIGN KEY ("reward_order_id") REFERENCES "public"."orders"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

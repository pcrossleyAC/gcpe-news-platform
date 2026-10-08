ALTER TABLE "nod_settings" ADD COLUMN "emergency_feed_checked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "nod_settings" ADD COLUMN "emergency_feed_seeded_url" text;--> statement-breakpoint
ALTER TABLE "nod_settings" ADD COLUMN "emergency_feed_result" jsonb;
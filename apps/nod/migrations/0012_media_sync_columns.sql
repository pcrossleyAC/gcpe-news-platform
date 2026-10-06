ALTER TABLE "nod_settings" ADD COLUMN "media_sync_since" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "nod_settings" ADD COLUMN "media_sync_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "nod_settings" ADD COLUMN "media_sync_result" jsonb;
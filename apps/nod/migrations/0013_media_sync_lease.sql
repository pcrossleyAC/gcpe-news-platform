ALTER TABLE "nod_settings" ADD COLUMN "media_sync_lease" uuid;--> statement-breakpoint
ALTER TABLE "nod_settings" ADD COLUMN "media_sync_lease_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "nod_settings" ADD COLUMN "media_sync_run_start" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "nod_settings" ADD COLUMN "media_sync_cursor" text;
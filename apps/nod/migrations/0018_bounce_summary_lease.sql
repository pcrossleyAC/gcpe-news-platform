ALTER TABLE "nod_settings" ADD COLUMN "bounce_summary_checked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "nod_settings" ADD COLUMN "bounce_summary_lease" uuid;--> statement-breakpoint
ALTER TABLE "nod_settings" ADD COLUMN "bounce_summary_lease_until" timestamp with time zone;
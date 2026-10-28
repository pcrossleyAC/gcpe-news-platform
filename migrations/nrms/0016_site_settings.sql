CREATE TABLE "site_settings_drafts" (
	"editor_id" text PRIMARY KEY NOT NULL,
	"document" jsonb NOT NULL,
	"base_revision" integer,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "site_settings_revisions" (
	"revision" integer PRIMARY KEY NOT NULL,
	"document" jsonb NOT NULL,
	"published_at" timestamp with time zone DEFAULT now() NOT NULL,
	"published_by_id" text NOT NULL,
	"published_by_name" text NOT NULL,
	"note" text
);
--> statement-breakpoint
ALTER TABLE "site_log" DROP CONSTRAINT "site_log_area_check";--> statement-breakpoint
ALTER TABLE "site_log" ADD CONSTRAINT "site_log_area_check" CHECK ("site_log"."area" IN ('carousel','pins','live-feed','blue-bridge','links','files','features','settings'));
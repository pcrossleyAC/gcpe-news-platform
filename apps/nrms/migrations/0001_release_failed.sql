ALTER TABLE "releases" DROP CONSTRAINT "releases_status_check";--> statement-breakpoint
ALTER TABLE "releases" ADD COLUMN "last_error" text;--> statement-breakpoint
ALTER TABLE "releases" ADD CONSTRAINT "releases_status_check" CHECK ("releases"."status" IN ('draft','scheduled','published','failed'));
ALTER TABLE "news_releases" ADD COLUMN "imported_version" integer;--> statement-breakpoint
ALTER TABLE "news_releases" ADD COLUMN "imported_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "news_releases" ADD COLUMN "import_hash" text;--> statement-breakpoint
ALTER TABLE "site_settings" ADD COLUMN "website_imported_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "site_settings" ADD COLUMN "website_imported_version" integer;
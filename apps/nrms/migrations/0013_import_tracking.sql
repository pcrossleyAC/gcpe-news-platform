ALTER TABLE "news_releases" ADD COLUMN "imported_version" integer;--> statement-breakpoint
ALTER TABLE "news_releases" ADD COLUMN "imported_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "news_releases" ADD COLUMN "import_hash" text;--> statement-breakpoint
ALTER TABLE "site_settings" ADD COLUMN "website_imported_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "site_settings" ADD COLUMN "website_imported_version" integer;--> statement-breakpoint
ALTER TABLE "site_settings" ADD COLUMN "website_import_hash" text;--> statement-breakpoint
CREATE UNIQUE INDEX "government_terms_legacy_id_idx" ON "government_terms" USING btree ("legacy_id") WHERE "government_terms"."legacy_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "media_lists_legacy_id_idx" ON "media_lists" USING btree ("legacy_id") WHERE "media_lists"."legacy_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "page_images_legacy_id_idx" ON "page_images" USING btree ("legacy_id") WHERE "page_images"."legacy_id" IS NOT NULL;
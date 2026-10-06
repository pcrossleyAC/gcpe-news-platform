DROP INDEX "news_releases_type_key_idx";--> statement-breakpoint
CREATE UNIQUE INDEX "news_releases_key_idx" ON "news_releases" USING btree (lower("key")) WHERE "news_releases"."key" IS NOT NULL;
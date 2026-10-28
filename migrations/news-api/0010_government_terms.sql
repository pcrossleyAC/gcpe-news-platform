CREATE TABLE "government_terms" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"published_at" timestamp with time zone NOT NULL,
	"document" jsonb NOT NULL,
	CONSTRAINT "government_terms_single_row" CHECK ("government_terms"."id" = 1)
);
--> statement-breakpoint
ALTER TABLE "changes" DROP CONSTRAINT "changes_kind_check";--> statement-breakpoint
ALTER TABLE "changes" ADD CONSTRAINT "changes_kind_check" CHECK ("changes"."kind" IN ('post.upserted', 'post.unpublished', 'home', 'slides', 'resource_links', 'ministry', 'sector', 'theme', 'tag', 'site_settings', 'government_terms'));
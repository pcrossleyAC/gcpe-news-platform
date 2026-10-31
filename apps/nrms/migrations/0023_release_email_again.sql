ALTER TABLE "news_releases" ADD COLUMN "email_again" jsonb;--> statement-breakpoint
ALTER TABLE "news_releases" ADD COLUMN "corrections_emailed" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "news_releases" ADD COLUMN "last_email_again" jsonb;
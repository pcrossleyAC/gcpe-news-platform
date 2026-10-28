ALTER TABLE "site_posts" ADD COLUMN "lead_ministry" text;--> statement-breakpoint
CREATE INDEX "site_posts_lead_ministry_idx" ON "site_posts" USING btree ("lead_ministry");
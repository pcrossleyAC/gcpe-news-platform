ALTER TABLE "posts" ADD COLUMN "origin" text DEFAULT 'event' NOT NULL;--> statement-breakpoint
ALTER TABLE "posts" ADD CONSTRAINT "posts_origin_check" CHECK ("posts"."origin" IN ('legacy', 'event'));
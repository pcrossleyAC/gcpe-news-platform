ALTER TABLE "items" ADD COLUMN "media_text" text;--> statement-breakpoint
ALTER TABLE "items" ADD COLUMN "media_list_keys" text[] DEFAULT '{}'::text[] NOT NULL;
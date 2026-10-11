ALTER TABLE "posts" ADD COLUMN "search_text" text;--> statement-breakpoint
ALTER TABLE "posts" ADD COLUMN "search_vector" "tsvector" GENERATED ALWAYS AS (to_tsvector('english'::regconfig, coalesce(search_text, ''))) STORED;--> statement-breakpoint
CREATE INDEX "posts_search_vector_idx" ON "posts" USING gin ("search_vector");
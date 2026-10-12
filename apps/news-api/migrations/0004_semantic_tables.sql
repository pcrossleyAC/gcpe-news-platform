CREATE TABLE "change_feed_state" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"pruned_through" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "change_feed_state_single_row" CHECK ("change_feed_state"."id" = 1)
);
--> statement-breakpoint
CREATE TABLE "changes" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"key" text,
	"at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	CONSTRAINT "changes_kind_check" CHECK ("changes"."kind" IN ('post.upserted', 'post.unpublished', 'home', 'slides', 'resource_links', 'ministry', 'sector', 'theme', 'tag'))
);
--> statement-breakpoint
CREATE TABLE "post_embeddings" (
	"post_key" text PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"dimensions" integer NOT NULL,
	"text_hash" text NOT NULL,
	"embedding" real[] NOT NULL,
	"embedded_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "post_related" (
	"post_key" text PRIMARY KEY NOT NULL,
	"related_keys" text[] NOT NULL,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "posts" ADD COLUMN "embedding_text_hash" text;--> statement-breakpoint
ALTER TABLE "post_embeddings" ADD CONSTRAINT "post_embeddings_post_key_posts_key_fk" FOREIGN KEY ("post_key") REFERENCES "public"."posts"("key") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "post_related" ADD CONSTRAINT "post_related_post_key_posts_key_fk" FOREIGN KEY ("post_key") REFERENCES "public"."posts"("key") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
CREATE INDEX "changes_at_idx" ON "changes" USING btree ("at");
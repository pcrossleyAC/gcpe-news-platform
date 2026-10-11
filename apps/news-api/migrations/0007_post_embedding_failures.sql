CREATE TABLE "post_embedding_failures" (
	"post_key" text PRIMARY KEY NOT NULL,
	"text_hash" text NOT NULL,
	"failed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "post_embedding_failures" ADD CONSTRAINT "post_embedding_failures_post_key_posts_key_fk" FOREIGN KEY ("post_key") REFERENCES "public"."posts"("key") ON DELETE cascade ON UPDATE cascade;
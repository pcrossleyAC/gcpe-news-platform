CREATE TABLE "public_import_posts" (
	"key" text PRIMARY KEY NOT NULL,
	"imported_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "public_import_posts" ADD CONSTRAINT "public_import_posts_key_posts_key_fk" FOREIGN KEY ("key") REFERENCES "public"."posts"("key") ON DELETE cascade ON UPDATE cascade;
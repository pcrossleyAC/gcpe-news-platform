CREATE TABLE "release_files" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"release_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"storage_key" text NOT NULL,
	"label" text NOT NULL,
	"content_type" text NOT NULL,
	"size" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "release_files_storage_key_unique" UNIQUE("storage_key"),
	CONSTRAINT "release_files_kind_check" CHECK ("release_files"."kind" IN ('translation','asset')),
	CONSTRAINT "release_files_label_length" CHECK (char_length("release_files"."label") <= 200)
);
--> statement-breakpoint
ALTER TABLE "release_files" ADD CONSTRAINT "release_files_release_id_news_releases_id_fk" FOREIGN KEY ("release_id") REFERENCES "public"."news_releases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "release_files_release_kind_idx" ON "release_files" USING btree ("release_id","kind");
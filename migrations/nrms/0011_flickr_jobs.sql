CREATE TABLE "flickr_jobs" (
	"release_id" uuid PRIMARY KEY NOT NULL,
	"photo_id" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"first_attempt_at" timestamp with time zone,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_error" text,
	"static_url" text,
	"alerted_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "flickr_jobs_status_check" CHECK ("flickr_jobs"."status" IN ('pending','done','gave_up'))
);
--> statement-breakpoint
ALTER TABLE "news_releases" ADD COLUMN "flickr_alert" text;--> statement-breakpoint
ALTER TABLE "flickr_jobs" ADD CONSTRAINT "flickr_jobs_release_id_news_releases_id_fk" FOREIGN KEY ("release_id") REFERENCES "public"."news_releases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "flickr_jobs_due_idx" ON "flickr_jobs" USING btree ("next_attempt_at") WHERE "flickr_jobs"."status" = 'pending';
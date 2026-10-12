CREATE TABLE "site_posts" (
	"key" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"headline" text NOT NULL,
	"summary" text,
	"publish_date" text NOT NULL,
	"published_at" timestamp with time zone NOT NULL,
	"month" text NOT NULL,
	"categories" text[] NOT NULL,
	"indexed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "site_posts_month_idx" ON "site_posts" USING btree ("month","published_at");--> statement-breakpoint
CREATE INDEX "site_posts_categories_idx" ON "site_posts" USING gin ("categories");
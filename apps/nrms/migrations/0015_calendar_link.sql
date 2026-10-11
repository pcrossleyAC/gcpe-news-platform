CREATE TABLE "calendar_activities" (
	"id" integer PRIMARY KEY NOT NULL,
	"is_confidential" boolean NOT NULL,
	"is_deleted" boolean NOT NULL,
	"title" text,
	"details" text,
	"start_at" timestamp with time zone,
	"end_at" timestamp with time zone,
	"nr_at" timestamp with time zone,
	"is_all_day" boolean,
	"is_confirmed" boolean,
	"contact_ministry_key" text,
	"shared_ministry_keys" text[] DEFAULT '{}'::text[] NOT NULL,
	"category_names" text[] DEFAULT '{}'::text[] NOT NULL,
	"city_name" text,
	"theme_keys" text[] DEFAULT '{}'::text[] NOT NULL,
	"tag_keys" text[] DEFAULT '{}'::text[] NOT NULL,
	"sector_keys" text[] DEFAULT '{}'::text[] NOT NULL,
	"translations" text[] DEFAULT '{}'::text[] NOT NULL,
	CONSTRAINT "calendar_activities_confidential_id_only" CHECK (NOT "calendar_activities"."is_confidential" OR ("calendar_activities"."title" IS NULL AND "calendar_activities"."details" IS NULL AND "calendar_activities"."start_at" IS NULL AND "calendar_activities"."end_at" IS NULL AND "calendar_activities"."nr_at" IS NULL
        AND "calendar_activities"."is_all_day" IS NULL AND "calendar_activities"."is_confirmed" IS NULL AND "calendar_activities"."contact_ministry_key" IS NULL AND "calendar_activities"."city_name" IS NULL
        AND cardinality("calendar_activities"."shared_ministry_keys") = 0 AND cardinality("calendar_activities"."category_names") = 0 AND cardinality("calendar_activities"."theme_keys") = 0
        AND cardinality("calendar_activities"."tag_keys") = 0 AND cardinality("calendar_activities"."sector_keys") = 0 AND cardinality("calendar_activities"."translations") = 0))
);
--> statement-breakpoint
CREATE TABLE "calendar_viewers" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"is_active" boolean NOT NULL,
	"calendar_role" text,
	"organization_keys" text[] DEFAULT '{}'::text[] NOT NULL
);
--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "is_hq" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE INDEX "calendar_activities_forecast_idx" ON "calendar_activities" USING btree ("start_at") WHERE NOT "calendar_activities"."is_confidential" AND NOT "calendar_activities"."is_deleted";--> statement-breakpoint
CREATE INDEX "news_releases_publish_at_idx" ON "news_releases" USING btree ("publish_at");
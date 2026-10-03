CREATE TABLE "categories" (
	"kind" text NOT NULL,
	"key" text NOT NULL,
	"name" text,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"is_active" boolean NOT NULL,
	"social" jsonb NOT NULL,
	"ministry" jsonb,
	"timestamp" timestamp with time zone NOT NULL,
	CONSTRAINT "categories_kind_key_pk" PRIMARY KEY("kind","key")
);
--> statement-breakpoint
CREATE TABLE "category_features" (
	"kind" text NOT NULL,
	"key" text NOT NULL,
	"top_post_key" text,
	"feature_post_key" text,
	CONSTRAINT "category_features_kind_key_pk" PRIMARY KEY("kind","key")
);
--> statement-breakpoint
CREATE TABLE "home" (
	"key" text PRIMARY KEY DEFAULT 'default' NOT NULL,
	"top_post_key" text,
	"feature_post_key" text,
	"live_webcast_flash_media_manifest_url" text,
	"live_webcast_m3u_playlist" text,
	"granville" text,
	"timestamp" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "posts" (
	"key" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"reference" text,
	"atom_id" text,
	"publish_date" timestamp with time zone NOT NULL,
	"lead_ministry_key" text,
	"summary" text,
	"social_media_summary" text,
	"social_media_headline" text,
	"keywords" text,
	"location" text,
	"has_media_assets" boolean NOT NULL,
	"has_translations" boolean NOT NULL,
	"is_news_on_demand" boolean NOT NULL,
	"asset_url" text,
	"redirect_uri" text,
	"documents" jsonb NOT NULL,
	"ministry_keys" text[] NOT NULL,
	"sector_keys" text[] NOT NULL,
	"tag_keys" text[] NOT NULL,
	"theme_keys" text[] NOT NULL,
	"index_keys" text[] NOT NULL,
	"assets" jsonb,
	"translations" jsonb,
	"is_published" boolean DEFAULT true NOT NULL,
	"timestamp" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "resource_links" (
	"sort_index" integer PRIMARY KEY NOT NULL,
	"text" text NOT NULL,
	"uri" text NOT NULL,
	"timestamp" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "slides" (
	"id" uuid PRIMARY KEY NOT NULL,
	"sort_index" integer NOT NULL,
	"headline" text,
	"summary" text,
	"action_label" text,
	"action_uri" text,
	"image" "bytea",
	"image_type" text,
	"facebook_post_uri" text,
	"justify" text,
	"timestamp" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "aggregate_sequences" (
	"aggregate_id" text PRIMARY KEY NOT NULL,
	"last_sequence" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "inbox_events" (
	"event_id" uuid PRIMARY KEY NOT NULL,
	"source" text NOT NULL,
	"type" text NOT NULL,
	"outcome" text NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "inbox_positions" (
	"source" text NOT NULL,
	"aggregate_id" text NOT NULL,
	"last_sequence" integer NOT NULL,
	CONSTRAINT "inbox_positions_source_aggregate_id_pk" PRIMARY KEY("source","aggregate_id")
);
--> statement-breakpoint
CREATE TABLE "outbox_deliveries" (
	"event_id" uuid NOT NULL,
	"subscriber" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"locked_until" timestamp with time zone,
	"last_error" text,
	"delivered_at" timestamp with time zone,
	CONSTRAINT "outbox_deliveries_event_id_subscriber_pk" PRIMARY KEY("event_id","subscriber")
);
--> statement-breakpoint
CREATE TABLE "outbox_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"aggregate_id" text NOT NULL,
	"sequence" integer NOT NULL,
	"envelope" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "outbox_deliveries" ADD CONSTRAINT "outbox_deliveries_event_id_outbox_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."outbox_events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "categories_kind_key_lower_idx" ON "categories" USING btree ("kind",lower("key"));--> statement-breakpoint
CREATE UNIQUE INDEX "posts_key_lower_idx" ON "posts" USING btree (lower("key"));--> statement-breakpoint
CREATE INDEX "posts_reference_lower_idx" ON "posts" USING btree (lower("reference"));--> statement-breakpoint
CREATE INDEX "posts_publish_date_idx" ON "posts" USING btree ("publish_date" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "posts_index_keys_idx" ON "posts" USING gin ("index_keys");--> statement-breakpoint
CREATE INDEX "outbox_deliveries_due_idx" ON "outbox_deliveries" USING btree ("status","next_attempt_at");
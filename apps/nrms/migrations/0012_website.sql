CREATE TABLE "carousels" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"state" text NOT NULL,
	"go_live_at" timestamp with time zone,
	"went_live_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "carousels_state_check" CHECK ("carousels"."state" IN ('live','next','past')),
	CONSTRAINT "carousels_next_has_go_live_at" CHECK ("carousels"."state" <> 'next' OR "carousels"."go_live_at" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "emergency_pins" (
	"slot" text PRIMARY KEY NOT NULL,
	"pinned" boolean DEFAULT false NOT NULL,
	"slide_id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"headline" text DEFAULT '' NOT NULL,
	"summary" text DEFAULT '' NOT NULL,
	"action_url" text DEFAULT '' NOT NULL,
	"facebook_post_url" text DEFAULT '' NOT NULL,
	"justify" text DEFAULT 'left' NOT NULL,
	"image" "bytea",
	"image_type" text,
	"version" integer DEFAULT 1 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "emergency_pins_slot_check" CHECK ("emergency_pins"."slot" IN ('primary','secondary')),
	CONSTRAINT "emergency_pins_justify_check" CHECK ("emergency_pins"."justify" IN ('left','right'))
);
--> statement-breakpoint
CREATE TABLE "site_files" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"storage_key" text NOT NULL,
	"name" text NOT NULL,
	"content_type" text NOT NULL,
	"size" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text NOT NULL,
	CONSTRAINT "site_files_storage_key_unique" UNIQUE("storage_key"),
	CONSTRAINT "site_files_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "site_log" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor_id" text NOT NULL,
	"actor_name" text NOT NULL,
	"area" text NOT NULL,
	"text" text NOT NULL,
	CONSTRAINT "site_log_area_check" CHECK ("site_log"."area" IN ('carousel','pins','live-feed','blue-bridge','links','files','features'))
);
--> statement-breakpoint
CREATE TABLE "site_settings" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"live_feed_enabled" boolean DEFAULT false NOT NULL,
	"live_manifest_url" text DEFAULT '' NOT NULL,
	"live_m3u_url" text DEFAULT '' NOT NULL,
	"granville" text,
	"links_version" integer DEFAULT 1 NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "site_settings_id_check" CHECK ("site_settings"."id" = 1)
);
--> statement-breakpoint
CREATE TABLE "resource_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sort_index" integer NOT NULL,
	"text" text NOT NULL,
	"url" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "slides" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"carousel_id" uuid NOT NULL,
	"sort_index" integer NOT NULL,
	"headline" text NOT NULL,
	"summary" text DEFAULT '' NOT NULL,
	"action_url" text DEFAULT '' NOT NULL,
	"facebook_post_url" text DEFAULT '' NOT NULL,
	"justify" text DEFAULT 'left' NOT NULL,
	"image" "bytea",
	"image_type" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "slides_justify_check" CHECK ("slides"."justify" IN ('left','right'))
);
--> statement-breakpoint
ALTER TABLE "slides" ADD CONSTRAINT "slides_carousel_id_carousels_id_fk" FOREIGN KEY ("carousel_id") REFERENCES "public"."carousels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "carousels_one_live_idx" ON "carousels" USING btree ("state") WHERE "carousels"."state" = 'live';--> statement-breakpoint
CREATE UNIQUE INDEX "carousels_one_next_idx" ON "carousels" USING btree ("state") WHERE "carousels"."state" = 'next';--> statement-breakpoint
CREATE INDEX "site_log_at_idx" ON "site_log" USING btree ("at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "slides_carousel_sort_idx" ON "slides" USING btree ("carousel_id","sort_index");--> statement-breakpoint
INSERT INTO "site_settings" ("id") VALUES (1);
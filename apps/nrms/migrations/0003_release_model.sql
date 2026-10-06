CREATE TABLE "category_features" (
	"kind" text NOT NULL,
	"key" text NOT NULL,
	"top_release_id" uuid,
	"feature_release_id" uuid,
	CONSTRAINT "category_features_kind_key_pk" PRIMARY KEY("kind","key")
);
--> statement-breakpoint
CREATE TABLE "document_contacts" (
	"document_id" uuid NOT NULL,
	"language_id" integer NOT NULL,
	"sort_index" integer NOT NULL,
	"information" text NOT NULL,
	CONSTRAINT "document_contacts_document_id_language_id_sort_index_pk" PRIMARY KEY("document_id","language_id","sort_index")
);
--> statement-breakpoint
CREATE TABLE "document_languages" (
	"document_id" uuid NOT NULL,
	"language_id" integer NOT NULL,
	"page_title" text NOT NULL,
	"headline" text DEFAULT '' NOT NULL,
	"subheadline" text,
	"organizations" text,
	"byline" text,
	"body_html" text DEFAULT '' NOT NULL,
	"page_image_id" uuid,
	CONSTRAINT "document_languages_document_id_language_id_pk" PRIMARY KEY("document_id","language_id")
);
--> statement-breakpoint
CREATE TABLE "government_terms" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"is_current" boolean DEFAULT false NOT NULL,
	"legacy_id" uuid,
	CONSTRAINT "government_terms_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "media_lists" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" text NOT NULL,
	"display_name" text NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"legacy_id" uuid,
	CONSTRAINT "media_lists_key_unique" UNIQUE("key")
);
--> statement-breakpoint
CREATE TABLE "news_releases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"legacy_id" uuid,
	"type" text NOT NULL,
	"key" text,
	"reference" text,
	"year" integer,
	"year_release" integer,
	"ministry_release" integer,
	"term_id" uuid,
	"lead_ministry_key" text,
	"activity_id" integer,
	"status" text DEFAULT 'draft' NOT NULL,
	"publish_at" timestamp with time zone,
	"released_at" timestamp with time zone,
	"on_hold" boolean DEFAULT false NOT NULL,
	"to_web" boolean DEFAULT true NOT NULL,
	"to_subscribers" boolean DEFAULT false NOT NULL,
	"to_media_lists" boolean DEFAULT false NOT NULL,
	"asset_url" text,
	"asset_alt_text" text,
	"has_media_assets" boolean DEFAULT false NOT NULL,
	"has_translations" boolean DEFAULT false NOT NULL,
	"redirect_url" text,
	"keywords" text,
	"atom_id" text,
	"nod_subscribers" integer,
	"media_subscribers" integer,
	"last_error" text,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "news_releases_legacy_id_unique" UNIQUE("legacy_id"),
	CONSTRAINT "news_releases_type_check" CHECK ("news_releases"."type" IN ('release','story','factsheet','update','advisory')),
	CONSTRAINT "news_releases_status_check" CHECK ("news_releases"."status" IN ('draft','approved','scheduled','publishing','published','unpublishing','failed','deleted')),
	CONSTRAINT "news_releases_committed_has_time" CHECK ("news_releases"."status" NOT IN ('scheduled','publishing','published','unpublishing') OR "news_releases"."publish_at" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "number_counters" (
	"scope" text NOT NULL,
	"year" integer NOT NULL,
	"ministry" text DEFAULT '' NOT NULL,
	"last_value" integer NOT NULL,
	CONSTRAINT "number_counters_scope_year_ministry_pk" PRIMARY KEY("scope","year","ministry")
);
--> statement-breakpoint
CREATE TABLE "page_image_languages" (
	"image_id" uuid NOT NULL,
	"language_id" integer NOT NULL,
	"alt_text" text DEFAULT '' NOT NULL,
	CONSTRAINT "page_image_languages_image_id_language_id_pk" PRIMARY KEY("image_id","language_id")
);
--> statement-breakpoint
CREATE TABLE "page_images" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"mime_type" text NOT NULL,
	"bytes" "bytea" NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"legacy_id" uuid,
	CONSTRAINT "page_images_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "page_types" (
	"page_title" text NOT NULL,
	"language_id" integer NOT NULL,
	"release_type" text NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"layout" text DEFAULT 'formal' NOT NULL,
	"page_image_id" uuid,
	CONSTRAINT "page_types_page_title_language_id_pk" PRIMARY KEY("page_title","language_id")
);
--> statement-breakpoint
CREATE TABLE "release_categories" (
	"release_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"key" text NOT NULL,
	CONSTRAINT "release_categories_release_id_kind_key_pk" PRIMARY KEY("release_id","kind","key")
);
--> statement-breakpoint
CREATE TABLE "release_documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"release_id" uuid NOT NULL,
	"sort_index" integer NOT NULL,
	"layout" text DEFAULT 'formal' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "release_languages" (
	"release_id" uuid NOT NULL,
	"language_id" integer NOT NULL,
	"location" text DEFAULT '' NOT NULL,
	"summary" text DEFAULT '' NOT NULL,
	"summary_edited" boolean DEFAULT false NOT NULL,
	"social_media_summary" text,
	CONSTRAINT "release_languages_release_id_language_id_pk" PRIMARY KEY("release_id","language_id")
);
--> statement-breakpoint
CREATE TABLE "release_log" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"release_id" uuid NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor_id" text NOT NULL,
	"actor_name" text NOT NULL,
	"text" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "release_media_lists" (
	"release_id" uuid NOT NULL,
	"media_list_id" uuid NOT NULL,
	CONSTRAINT "release_media_lists_release_id_media_list_id_pk" PRIMARY KEY("release_id","media_list_id")
);
--> statement-breakpoint
CREATE TABLE "release_publications" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"release_id" uuid NOT NULL,
	"published_at" timestamp with time zone NOT NULL,
	"actor_id" text NOT NULL,
	"actor_name" text NOT NULL,
	"record" jsonb NOT NULL
);
--> statement-breakpoint
ALTER TABLE "category_features" ADD CONSTRAINT "category_features_top_release_id_news_releases_id_fk" FOREIGN KEY ("top_release_id") REFERENCES "public"."news_releases"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "category_features" ADD CONSTRAINT "category_features_feature_release_id_news_releases_id_fk" FOREIGN KEY ("feature_release_id") REFERENCES "public"."news_releases"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_contacts" ADD CONSTRAINT "document_contacts_document_id_release_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."release_documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_languages" ADD CONSTRAINT "document_languages_document_id_release_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."release_documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "news_releases" ADD CONSTRAINT "news_releases_term_id_government_terms_id_fk" FOREIGN KEY ("term_id") REFERENCES "public"."government_terms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_image_languages" ADD CONSTRAINT "page_image_languages_image_id_page_images_id_fk" FOREIGN KEY ("image_id") REFERENCES "public"."page_images"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_types" ADD CONSTRAINT "page_types_page_image_id_page_images_id_fk" FOREIGN KEY ("page_image_id") REFERENCES "public"."page_images"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "release_categories" ADD CONSTRAINT "release_categories_release_id_news_releases_id_fk" FOREIGN KEY ("release_id") REFERENCES "public"."news_releases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "release_documents" ADD CONSTRAINT "release_documents_release_id_news_releases_id_fk" FOREIGN KEY ("release_id") REFERENCES "public"."news_releases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "release_languages" ADD CONSTRAINT "release_languages_release_id_news_releases_id_fk" FOREIGN KEY ("release_id") REFERENCES "public"."news_releases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "release_log" ADD CONSTRAINT "release_log_release_id_news_releases_id_fk" FOREIGN KEY ("release_id") REFERENCES "public"."news_releases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "release_media_lists" ADD CONSTRAINT "release_media_lists_release_id_news_releases_id_fk" FOREIGN KEY ("release_id") REFERENCES "public"."news_releases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "release_media_lists" ADD CONSTRAINT "release_media_lists_media_list_id_media_lists_id_fk" FOREIGN KEY ("media_list_id") REFERENCES "public"."media_lists"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "release_publications" ADD CONSTRAINT "release_publications_release_id_news_releases_id_fk" FOREIGN KEY ("release_id") REFERENCES "public"."news_releases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "government_terms_one_current_idx" ON "government_terms" USING btree ("is_current") WHERE "government_terms"."is_current";--> statement-breakpoint
CREATE UNIQUE INDEX "news_releases_type_key_idx" ON "news_releases" USING btree ("type",lower("key")) WHERE "news_releases"."key" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "news_releases_reference_idx" ON "news_releases" USING btree ("reference") WHERE "news_releases"."reference" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "news_releases_due_idx" ON "news_releases" USING btree ("publish_at") WHERE "news_releases"."status" IN ('scheduled','publishing','unpublishing');--> statement-breakpoint
CREATE INDEX "news_releases_status_idx" ON "news_releases" USING btree ("status");--> statement-breakpoint
CREATE INDEX "release_categories_key_idx" ON "release_categories" USING btree ("kind","key");--> statement-breakpoint
CREATE INDEX "release_documents_release_idx" ON "release_documents" USING btree ("release_id","sort_index");--> statement-breakpoint
CREATE INDEX "release_log_release_idx" ON "release_log" USING btree ("release_id","at");--> statement-breakpoint
CREATE INDEX "release_publications_release_idx" ON "release_publications" USING btree ("release_id","published_at");
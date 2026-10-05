CREATE TABLE "list_categories" (
	"key" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lists" (
	"list_key" text PRIMARY KEY NOT NULL,
	"category" text NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"topic_url" text DEFAULT '' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "subscriber_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"subscriber_id" uuid NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor" text NOT NULL,
	"action" text NOT NULL,
	"detail" text DEFAULT '' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "subscriber_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"token_hash" text NOT NULL,
	"purpose" text NOT NULL,
	"subscriber_id" uuid,
	"email" text NOT NULL,
	"pending" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	CONSTRAINT "subscriber_links_token_hash_unique" UNIQUE("token_hash"),
	CONSTRAINT "subscriber_links_purpose_check" CHECK ("subscriber_links"."purpose" IN ('verify','manage','change-email'))
);
--> statement-breakpoint
ALTER TABLE "subscribers" ADD COLUMN "status" text DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE "subscribers" ADD COLUMN "as_it_happens" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "subscribers" ADD COLUMN "digest" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "subscribers" ADD COLUMN "source" text DEFAULT 'self' NOT NULL;--> statement-breakpoint
ALTER TABLE "subscribers" ADD COLUMN "media_hub_contact_id" integer;--> statement-breakpoint
ALTER TABLE "subscribers" ADD COLUMN "ended_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "subscribers" ADD COLUMN "unsubscribe_version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "lists" ADD CONSTRAINT "lists_category_list_categories_key_fk" FOREIGN KEY ("category") REFERENCES "public"."list_categories"("key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscriber_history" ADD CONSTRAINT "subscriber_history_subscriber_id_subscribers_id_fk" FOREIGN KEY ("subscriber_id") REFERENCES "public"."subscribers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscriber_links" ADD CONSTRAINT "subscriber_links_subscriber_id_subscribers_id_fk" FOREIGN KEY ("subscriber_id") REFERENCES "public"."subscribers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "lists_category_key_idx" ON "lists" USING btree ("category","key");--> statement-breakpoint
CREATE INDEX "subscriber_history_subscriber_at_idx" ON "subscriber_history" USING btree ("subscriber_id","at");--> statement-breakpoint
CREATE INDEX "subscriber_links_email_created_idx" ON "subscriber_links" USING btree ("email","created_at");--> statement-breakpoint
ALTER TABLE "subscribers" ADD CONSTRAINT "subscribers_status_check" CHECK ("subscribers"."status" IN ('pending','active','disabled','deleted'));--> statement-breakpoint
ALTER TABLE "subscribers" ADD CONSTRAINT "subscribers_source_check" CHECK ("subscribers"."source" IN ('self','admin','media-hub','manual-media'));
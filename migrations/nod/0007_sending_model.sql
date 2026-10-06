CREATE TABLE "digest_runs" (
	"cutoff" timestamp with time zone PRIMARY KEY NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"ran_at" timestamp with time zone DEFAULT now() NOT NULL,
	"subscribers" integer DEFAULT 0 NOT NULL,
	"groups" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "items" (
	"key" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"post_kind" text,
	"list_keys" text[] DEFAULT '{}'::text[] NOT NULL,
	"title" text NOT NULL,
	"summary" text DEFAULT '' NOT NULL,
	"url" text NOT NULL,
	"published_at" timestamp with time zone NOT NULL,
	"to_subscribers" boolean DEFAULT true NOT NULL,
	"withdrawn_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "items_kind_check" CHECK ("items"."kind" IN ('release','emergency'))
);
--> statement-breakpoint
CREATE TABLE "job_recipients" (
	"job_id" uuid NOT NULL,
	"subscriber_id" uuid NOT NULL,
	"chunk_index" integer,
	CONSTRAINT "job_recipients_job_id_subscriber_id_pk" PRIMARY KEY("job_id","subscriber_id")
);
--> statement-breakpoint
CREATE TABLE "nod_settings" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"paused" boolean DEFAULT false NOT NULL,
	"last_digest_cutoff" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "nod_settings_singleton" CHECK ("nod_settings"."id" = 1)
);
--> statement-breakpoint
CREATE TABLE "operations_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor" text NOT NULL,
	"action" text NOT NULL,
	"detail" text DEFAULT '' NOT NULL
);
--> statement-breakpoint
ALTER TABLE "send_jobs" DROP CONSTRAINT "send_jobs_status_check";--> statement-breakpoint
ALTER TABLE "deliveries" ADD COLUMN "item_key" text;--> statement-breakpoint
ALTER TABLE "deliveries" ADD COLUMN "mode" text DEFAULT 'as_it_happens' NOT NULL;--> statement-breakpoint
ALTER TABLE "deliveries" ADD COLUMN "job_id" uuid;--> statement-breakpoint
ALTER TABLE "deliveries" ADD COLUMN "attempted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "send_jobs" ADD COLUMN "job_key" text;--> statement-breakpoint
ALTER TABLE "send_jobs" ADD COLUMN "priority" text DEFAULT 'immediate' NOT NULL;--> statement-breakpoint
ALTER TABLE "send_jobs" ADD COLUMN "item_key" text;--> statement-breakpoint
ALTER TABLE "subscriber_links" ADD COLUMN "origin" text DEFAULT 'request' NOT NULL;--> statement-breakpoint
ALTER TABLE "job_recipients" ADD CONSTRAINT "job_recipients_job_id_send_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."send_jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_recipients" ADD CONSTRAINT "job_recipients_subscriber_id_subscribers_id_fk" FOREIGN KEY ("subscriber_id") REFERENCES "public"."subscribers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "items_published_at_idx" ON "items" USING btree ("published_at");--> statement-breakpoint
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_job_id_send_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."send_jobs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_mode_check" CHECK ("deliveries"."mode" IN ('as_it_happens','digest','media'));--> statement-breakpoint
ALTER TABLE "send_jobs" ADD CONSTRAINT "send_jobs_priority_check" CHECK ("send_jobs"."priority" IN ('immediate','digest','media','system'));--> statement-breakpoint
ALTER TABLE "send_jobs" ADD CONSTRAINT "send_jobs_status_check" CHECK ("send_jobs"."status" IN ('pending','sent','failed','cancelled'));--> statement-breakpoint
ALTER TABLE "subscriber_links" ADD CONSTRAINT "subscriber_links_origin_check" CHECK ("subscriber_links"."origin" IN ('request','send'));
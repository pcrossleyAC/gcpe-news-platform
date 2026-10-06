CREATE TABLE "deliveries" (
	"release_key" text NOT NULL,
	"subscriber_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "deliveries_release_key_subscriber_id_pk" PRIMARY KEY("release_key","subscriber_id")
);
--> statement-breakpoint
CREATE TABLE "send_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"release_key" text NOT NULL,
	"kind" text DEFAULT 'as_it_happens' NOT NULL,
	"subject" text,
	"html" text,
	"text" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"locked_until" timestamp with time zone,
	"batch_id" uuid,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "send_jobs_status_check" CHECK ("send_jobs"."status" IN ('pending','sent','failed'))
);
--> statement-breakpoint
CREATE TABLE "subscribers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"manage_token" text NOT NULL,
	"verified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "subscribers_manage_token_unique" UNIQUE("manage_token")
);
--> statement-breakpoint
CREATE TABLE "subscriptions" (
	"subscriber_id" uuid NOT NULL,
	"list_key" text NOT NULL,
	"as_it_happens" boolean DEFAULT true NOT NULL,
	CONSTRAINT "subscriptions_subscriber_id_list_key_pk" PRIMARY KEY("subscriber_id","list_key")
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
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_subscriber_id_subscribers_id_fk" FOREIGN KEY ("subscriber_id") REFERENCES "public"."subscribers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_subscriber_id_subscribers_id_fk" FOREIGN KEY ("subscriber_id") REFERENCES "public"."subscribers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbox_deliveries" ADD CONSTRAINT "outbox_deliveries_event_id_outbox_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."outbox_events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "send_jobs_release_key_kind_idx" ON "send_jobs" USING btree ("release_key","kind");--> statement-breakpoint
CREATE UNIQUE INDEX "subscribers_email_lower_idx" ON "subscribers" USING btree (lower("email"));--> statement-breakpoint
CREATE INDEX "outbox_deliveries_due_idx" ON "outbox_deliveries" USING btree ("status","next_attempt_at");
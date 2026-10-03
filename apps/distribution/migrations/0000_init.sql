CREATE TABLE "batches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"app_id" text NOT NULL,
	"idempotency_key" text,
	"subject" text,
	"html" text,
	"text" text,
	"headers" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"batch_id" uuid NOT NULL,
	"email" text NOT NULL,
	"substitutions" jsonb,
	"priority" integer NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"locked_until" timestamp with time zone,
	"last_error" text,
	"sent_at" timestamp with time zone,
	"original_recipient" text,
	CONSTRAINT "messages_status_check" CHECK ("messages"."status" IN ('pending','sent','failed'))
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
ALTER TABLE "messages" ADD CONSTRAINT "messages_batch_id_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."batches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbox_deliveries" ADD CONSTRAINT "outbox_deliveries_event_id_outbox_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."outbox_events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "batches_app_id_idempotency_key_idx" ON "batches" USING btree ("app_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "messages_due_idx" ON "messages" USING btree ("priority" DESC NULLS LAST,"next_attempt_at") WHERE "messages"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "outbox_deliveries_due_idx" ON "outbox_deliveries" USING btree ("status","next_attempt_at");
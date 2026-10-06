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
CREATE INDEX "outbox_deliveries_due_idx" ON "outbox_deliveries" USING btree ("status","next_attempt_at");
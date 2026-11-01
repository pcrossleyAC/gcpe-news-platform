CREATE TABLE "outbox_dismissals" (
	"app" text NOT NULL,
	"event_id" uuid NOT NULL,
	"subscriber" text NOT NULL,
	"event_type" text NOT NULL,
	"about" text,
	"last_error" text,
	"queued_at" timestamp with time zone NOT NULL,
	"replaced" boolean DEFAULT false NOT NULL,
	"dismissed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor_id" text NOT NULL,
	"actor_name" text NOT NULL,
	CONSTRAINT "outbox_dismissals_app_event_id_subscriber_pk" PRIMARY KEY("app","event_id","subscriber")
);
--> statement-breakpoint
CREATE INDEX "outbox_dismissals_dismissed_at_idx" ON "outbox_dismissals" USING btree ("dismissed_at");
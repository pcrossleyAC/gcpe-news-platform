CREATE TABLE "rebuild_queue" (
	"page_id" text PRIMARY KEY NOT NULL,
	"priority" smallint NOT NULL,
	"seq" bigserial NOT NULL,
	"queued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "site_state" (
	"id" integer PRIMARY KEY NOT NULL,
	"change_cursor" bigint,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "site_state_single_row" CHECK ("site_state"."id" = 1)
);
--> statement-breakpoint
CREATE INDEX "rebuild_queue_order_idx" ON "rebuild_queue" USING btree ("priority","seq");
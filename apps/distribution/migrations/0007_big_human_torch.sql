CREATE TABLE "bounces" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_id" text NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"raw" text NOT NULL,
	"kind" text NOT NULL,
	"recipient" text,
	"status" text,
	"hard" boolean,
	"method" text,
	"message_id" uuid,
	"matched" boolean DEFAULT false NOT NULL,
	"processed_at" timestamp with time zone,
	CONSTRAINT "bounces_kind_check" CHECK ("bounces"."kind" IN ('bounce','ignored'))
);
--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "bounced_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "bounce_status" text;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "bounce_hard" boolean;--> statement-breakpoint
ALTER TABLE "bounces" ADD CONSTRAINT "bounces_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "bounces_source_id_idx" ON "bounces" USING btree ("source_id");
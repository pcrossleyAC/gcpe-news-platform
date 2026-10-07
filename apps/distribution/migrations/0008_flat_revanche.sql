CREATE TABLE "bounce_inbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"raw" text NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "distribution_settings" ADD COLUMN "bounces_checked_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "bounce_inbox_unprocessed_idx" ON "bounce_inbox" USING btree ("received_at") WHERE "bounce_inbox"."processed_at" IS NULL;
ALTER TABLE "deliveries" ADD COLUMN "distribution_batch_id" uuid;--> statement-breakpoint
ALTER TABLE "deliveries" ADD COLUMN "hard_bounced_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "deliveries" ADD COLUMN "bounce_status" text;--> statement-breakpoint
CREATE INDEX "deliveries_distribution_batch_id_idx" ON "deliveries" USING btree ("distribution_batch_id");
ALTER TABLE "bounces" ADD COLUMN "diagnostic" text;--> statement-breakpoint
ALTER TABLE "bounces" ADD COLUMN "original_subject" text;--> statement-breakpoint
CREATE INDEX "bounces_processed_at_idx" ON "bounces" USING btree ("processed_at");
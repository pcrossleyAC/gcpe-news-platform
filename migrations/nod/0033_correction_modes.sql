-- Corrected copies (owner decision 2026-10-31). Every statement here is metadata-only or touches
-- only small tables, so the locks last milliseconds; lock_timeout makes a busy table fail the
-- deploy rather than stall NoD while waiting. The mode check is NOT VALID: every existing row is a
-- first send, so the table is not scanned; new rows are still checked.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
ALTER TABLE "deliveries" DROP CONSTRAINT "deliveries_mode_check";--> statement-breakpoint
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_mode_check" CHECK ("deliveries"."mode" IN ('as_it_happens','digest','media') OR "deliveries"."mode" ~ '^correction:[1-9][0-9]*$') NOT VALID;--> statement-breakpoint
ALTER TABLE "items" ADD COLUMN "corrections_sent" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX "send_jobs_item_key_idx" ON "send_jobs" USING btree ("item_key");--> statement-breakpoint
SET LOCAL lock_timeout = DEFAULT;

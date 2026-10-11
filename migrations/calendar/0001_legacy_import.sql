ALTER TABLE "activities" ADD COLUMN "imported_version" integer;--> statement-breakpoint
ALTER TABLE "activity_changes" ADD COLUMN "legacy_key" text;--> statement-breakpoint
CREATE UNIQUE INDEX "activity_changes_legacy_key_idx" ON "activity_changes" USING btree ("legacy_key");
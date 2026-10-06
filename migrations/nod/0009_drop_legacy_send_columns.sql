ALTER TABLE "subscribers" DROP CONSTRAINT "subscribers_manage_token_unique";--> statement-breakpoint
DROP INDEX "send_jobs_release_key_kind_idx";--> statement-breakpoint
ALTER TABLE "deliveries" DROP CONSTRAINT "deliveries_release_key_subscriber_id_pk";--> statement-breakpoint
ALTER TABLE "deliveries" ALTER COLUMN "item_key" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "send_jobs" ALTER COLUMN "job_key" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_item_key_subscriber_id_mode_pk" PRIMARY KEY("item_key","subscriber_id","mode");--> statement-breakpoint
CREATE UNIQUE INDEX "send_jobs_job_key_idx" ON "send_jobs" USING btree ("job_key");--> statement-breakpoint
ALTER TABLE "deliveries" DROP COLUMN "release_key";--> statement-breakpoint
ALTER TABLE "deliveries" DROP COLUMN "chunk_index";--> statement-breakpoint
ALTER TABLE "send_jobs" DROP COLUMN "release_key";--> statement-breakpoint
ALTER TABLE "subscribers" DROP COLUMN "manage_token";
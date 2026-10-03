ALTER TABLE "send_jobs" ALTER COLUMN "batch_ids" SET DEFAULT '{}'::jsonb;--> statement-breakpoint
ALTER TABLE "deliveries" ADD COLUMN "chunk_index" integer;--> statement-breakpoint
ALTER TABLE "send_jobs" ADD COLUMN "chunks_assigned" boolean DEFAULT false NOT NULL;
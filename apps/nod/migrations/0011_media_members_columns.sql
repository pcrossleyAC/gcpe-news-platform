ALTER TABLE "subscribers" ADD COLUMN "media_hub_email_ref" text;--> statement-breakpoint
ALTER TABLE "subscribers" ADD COLUMN "needs_attention" text;--> statement-breakpoint
ALTER TABLE "subscribers" ADD COLUMN "attention_at" timestamp with time zone;
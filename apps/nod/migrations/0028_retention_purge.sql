CREATE TABLE "media_opt_outs" (
	"email_hash" text NOT NULL,
	"list_key" text NOT NULL,
	"opted_out_at" timestamp with time zone NOT NULL,
	CONSTRAINT "media_opt_outs_email_hash_list_key_pk" PRIMARY KEY("email_hash","list_key")
);
--> statement-breakpoint
ALTER TABLE "nod_settings" ADD COLUMN "purge_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "nod_settings" ADD COLUMN "purge_done_cutoff" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "nod_settings" ADD COLUMN "purge_lease" uuid;--> statement-breakpoint
ALTER TABLE "nod_settings" ADD COLUMN "purge_lease_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "nod_settings" ADD COLUMN "purge_result" jsonb;
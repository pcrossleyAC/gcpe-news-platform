ALTER TABLE "deliveries" ADD COLUMN "correction" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "deliveries" DROP CONSTRAINT "deliveries_mode_check";--> statement-breakpoint
ALTER TABLE "deliveries" DROP CONSTRAINT "deliveries_item_key_subscriber_id_mode_pk";--> statement-breakpoint
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_item_key_subscriber_id_mode_correction_pk" PRIMARY KEY("item_key","subscriber_id","mode","correction");--> statement-breakpoint
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_correction_check" CHECK (("deliveries"."mode" = 'correction') = ("deliveries"."correction" > 0));--> statement-breakpoint
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_mode_check" CHECK ("deliveries"."mode" IN ('as_it_happens','digest','media','correction'));

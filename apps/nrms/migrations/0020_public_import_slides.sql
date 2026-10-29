CREATE TABLE "public_import_carousel" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"carousel_id" uuid NOT NULL,
	"previous_live_id" uuid,
	"previous_live_updated_at" timestamp with time zone,
	"imported_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "public_import_carousel_id_check" CHECK ("public_import_carousel"."id" = 1)
);
--> statement-breakpoint
CREATE TABLE "public_import_slides" (
	"slide_id" uuid PRIMARY KEY NOT NULL,
	"legacy_key" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "public_import_carousel" ADD CONSTRAINT "public_import_carousel_carousel_id_carousels_id_fk" FOREIGN KEY ("carousel_id") REFERENCES "public"."carousels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "public_import_slides" ADD CONSTRAINT "public_import_slides_slide_id_slides_id_fk" FOREIGN KEY ("slide_id") REFERENCES "public"."slides"("id") ON DELETE cascade ON UPDATE no action;
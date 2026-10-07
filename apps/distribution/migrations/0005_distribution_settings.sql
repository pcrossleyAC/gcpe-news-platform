CREATE TABLE "distribution_settings" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"paused" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "distribution_settings_singleton" CHECK ("distribution_settings"."id" = 1)
);

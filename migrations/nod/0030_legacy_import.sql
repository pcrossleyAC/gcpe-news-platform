CREATE TABLE "legacy_subscriber_imports" (
	"subscriber_id" uuid PRIMARY KEY NOT NULL,
	"fingerprint" text NOT NULL,
	"imported_at" timestamp with time zone DEFAULT now() NOT NULL
);

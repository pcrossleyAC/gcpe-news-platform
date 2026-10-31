CREATE TABLE "site_file_tombstones" (
	"name_lower" text PRIMARY KEY NOT NULL,
	"deleted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_by" text NOT NULL
);

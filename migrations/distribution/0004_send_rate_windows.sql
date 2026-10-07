CREATE TABLE "send_rate_windows" (
	"window_start" timestamp with time zone PRIMARY KEY NOT NULL,
	"claimed" integer DEFAULT 0 NOT NULL
);

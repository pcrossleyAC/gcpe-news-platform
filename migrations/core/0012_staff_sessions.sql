CREATE TABLE "staff_sessions" (
	"sid" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"signed_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX "staff_sessions_user_id_idx" ON "staff_sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "staff_sessions_signed_at_idx" ON "staff_sessions" USING btree ("signed_at");
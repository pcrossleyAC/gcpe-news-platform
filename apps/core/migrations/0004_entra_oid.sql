ALTER TABLE "users" ADD COLUMN "entra_oid" text;--> statement-breakpoint
CREATE UNIQUE INDEX "users_entra_oid_idx" ON "users" USING btree ("entra_oid");--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_entra_link_check" CHECK (("users"."sign_in_method" = 'entra') = ("users"."entra_oid" IS NOT NULL));
CREATE TABLE "user_legacy_ids" (
	"system" text NOT NULL,
	"legacy_id" text NOT NULL,
	"user_id" uuid NOT NULL,
	CONSTRAINT "user_legacy_ids_system_legacy_id_pk" PRIMARY KEY("system","legacy_id"),
	CONSTRAINT "user_legacy_ids_system_check" CHECK ("user_legacy_ids"."system" IN ('calendar'))
);
--> statement-breakpoint
CREATE TABLE "user_organizations" (
	"user_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	CONSTRAINT "user_organizations_user_id_organization_id_pk" PRIMARY KEY("user_id","organization_id")
);
--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "email" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "is_hq" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "user_legacy_ids" ADD CONSTRAINT "user_legacy_ids_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_organizations" ADD CONSTRAINT "user_organizations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_organizations" ADD CONSTRAINT "user_organizations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "user_legacy_ids_user_idx" ON "user_legacy_ids" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "user_organizations_organization_idx" ON "user_organizations" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "role_grants_one_calendar_role" ON "role_grants" USING btree ("user_id") WHERE "role_grants"."role" LIKE 'Calendar.%';--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_active_needs_email" CHECK ("users"."is_active" = false OR "users"."email" IS NOT NULL);
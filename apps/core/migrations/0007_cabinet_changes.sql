CREATE TABLE "cabinet_changes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"scheduled_for" timestamp with time zone,
	"operations" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_by" text,
	"published_at" timestamp with time zone,
	"error" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cabinet_changes_status_check" CHECK ("cabinet_changes"."status" IN ('draft','scheduled','published','cancelled')),
	CONSTRAINT "cabinet_changes_scheduled_for_check" CHECK ("cabinet_changes"."status" <> 'scheduled' OR "cabinet_changes"."scheduled_for" IS NOT NULL)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "cabinet_changes_one_open_idx" ON "cabinet_changes" USING btree ((true)) WHERE "cabinet_changes"."status" IN ('draft','scheduled');
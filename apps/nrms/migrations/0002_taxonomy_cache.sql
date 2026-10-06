CREATE TABLE "category_terms" (
	"kind" text NOT NULL,
	"key" text NOT NULL,
	"display_name" text NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	CONSTRAINT "category_terms_kind_key_pk" PRIMARY KEY("kind","key")
);
--> statement-breakpoint
CREATE TABLE "organizations" (
	"key" text PRIMARY KEY NOT NULL,
	"display_name" text NOT NULL,
	"abbreviation" text,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL
);

CREATE TABLE "manual_reviews" (
	"page_id" text NOT NULL,
	"hash" text NOT NULL,
	"reviewed_by" text NOT NULL,
	"reviewed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "manual_reviews_page_id_hash_pk" PRIMARY KEY("page_id","hash")
);

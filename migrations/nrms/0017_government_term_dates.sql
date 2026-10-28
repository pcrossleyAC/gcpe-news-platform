CREATE TABLE "government_terms_published" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"hash" text NOT NULL,
	"published_at" timestamp with time zone NOT NULL,
	CONSTRAINT "government_terms_published_single_row" CHECK ("government_terms_published"."id" = 1)
);
--> statement-breakpoint
ALTER TABLE "government_terms" ADD COLUMN "start_date" date;--> statement-breakpoint
ALTER TABLE "government_terms" ADD COLUMN "label" text;--> statement-breakpoint
ALTER TABLE "government_terms" ADD COLUMN "legacy_archive_url" text;--> statement-breakpoint
ALTER TABLE "government_terms" ADD COLUMN "created_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "government_terms_start_date_idx" ON "government_terms" USING btree ("start_date") WHERE "government_terms"."start_date" IS NOT NULL;
--> statement-breakpoint
-- Backfill the legacy collections (spec 2026-10-28 §2). pre2001 and 2017-2021 dates are assumptions (Q-NG4), editable in the Hub.
-- Only fills blanks, matches by name, and leaves unknown names undated, so it is safe on a populated database and idempotent.
UPDATE "government_terms" AS gt
SET "start_date" = COALESCE(gt."start_date", v.start_date::date),
    "legacy_archive_url" = COALESCE(gt."legacy_archive_url", v.archive_url)
FROM (VALUES
  ('pre2001',   '1994-01-01', 'https://archive.news.gov.bc.ca/releases/index_pre2001.htm'),
  ('2001-2005', '2001-06-05', 'https://archive.news.gov.bc.ca/releases/index_2001-2005.htm'),
  ('2005-2009', '2005-05-18', 'https://archive.news.gov.bc.ca/releases/index_2005-2009.htm'),
  ('2009-2013', '2009-06-11', 'https://archive.news.gov.bc.ca/releases/index_2009-2013.htm'),
  ('2013-2017', '2013-06-10', 'https://archive.news.gov.bc.ca/releases/index_2013-2017.htm'),
  ('2017-2017', '2017-06-12', 'https://archive.news.gov.bc.ca/releases/index_2017-2017.htm'),
  ('2017-2021', '2017-07-18', 'https://archive.news.gov.bc.ca/releases/index_2017-2021.htm'),
  ('2020-2024', '2020-11-26', 'https://archive.news.gov.bc.ca/releases/index_2020-2024.htm'),
  ('2024-2028', '2024-11-18', 'https://archive.news.gov.bc.ca/releases/index_current.htm')
) AS v(name, start_date, archive_url)
WHERE gt."name" = v.name AND gt."start_date" IS NULL;

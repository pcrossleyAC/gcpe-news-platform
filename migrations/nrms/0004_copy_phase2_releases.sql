-- Copies Phase 2 releases (single JSON row each) into the normalised model. Phase 2 only
-- ever held English documents, so each JSON document becomes one English document here.
--
-- Phase 2 never enforced uniqueness on content->>'reference' (news_releases.reference does).
-- When two Phase 2 rows share a reference, only the earliest-created row (tiebreak: key) keeps
-- it; later duplicates get a NULL reference instead of aborting the migration. A draft is only
-- promoted to 'approved' when it's the row that actually keeps the reference.
WITH ranked AS (
  SELECT
    r.*,
    row_number() OVER (
      PARTITION BY NULLIF(r.content->>'reference', '')
      ORDER BY r.created_at, r.key
    ) AS reference_rank
  FROM releases r
)
INSERT INTO news_releases (type, key, reference, lead_ministry_key, status, publish_at, released_at,
  to_web, to_subscribers, to_media_lists, asset_url, has_media_assets, has_translations, redirect_url,
  keywords, last_error, created_at, updated_at)
SELECT
  CASE r.kind WHEN 'releases' THEN 'release' WHEN 'stories' THEN 'story' WHEN 'factsheets' THEN 'factsheet'
              WHEN 'updates' THEN 'update' ELSE 'advisory' END,
  r.key,
  CASE WHEN r.reference_rank = 1 THEN NULLIF(r.content->>'reference', '') ELSE NULL END,
  lower(r.content->>'leadMinistryKey'),
  CASE WHEN r.status = 'draft' AND r.reference_rank = 1 AND NULLIF(r.content->>'reference', '') IS NOT NULL THEN 'approved' ELSE r.status END,
  COALESCE(r.publish_at, r.published_at),
  r.published_at,
  COALESCE((r.content->'publishFlags'->>'toWeb')::boolean, true),
  COALESCE((r.content->'publishFlags'->>'toSubscribers')::boolean, false),
  COALESCE((r.content->'publishFlags'->>'toMediaLists')::boolean, false),
  r.content->>'assetUrl',
  COALESCE((r.content->>'hasMediaAssets')::boolean, false),
  COALESCE((r.content->>'hasTranslations')::boolean, false),
  r.content->>'redirectUri',
  r.content->>'keywords',
  r.last_error,
  r.created_at,
  r.updated_at
FROM ranked r;
--> statement-breakpoint
INSERT INTO release_languages (release_id, language_id, location, summary, summary_edited, social_media_summary)
SELECT n.id, 4105, COALESCE(r.content->>'location', ''), COALESCE(r.content->>'summary', ''), true, r.content->>'socialMediaSummary'
FROM releases r JOIN news_releases n ON n.key = r.key;
--> statement-breakpoint
INSERT INTO release_documents (id, release_id, sort_index, layout)
SELECT gen_random_uuid(), n.id, (d.ord - 1)::int, 'formal'
FROM releases r JOIN news_releases n ON n.key = r.key
CROSS JOIN LATERAL jsonb_array_elements(r.content->'documents') WITH ORDINALITY AS d(doc, ord);
--> statement-breakpoint
INSERT INTO document_languages (document_id, language_id, page_title, headline, subheadline, byline, body_html)
SELECT rd.id, 4105, COALESCE(d.doc->>'pageTitle', ''), COALESCE(d.doc->>'headline', ''), d.doc->>'subheadline', d.doc->>'byline', COALESCE(d.doc->>'detailsHtml', '')
FROM releases r JOIN news_releases n ON n.key = r.key
CROSS JOIN LATERAL jsonb_array_elements(r.content->'documents') WITH ORDINALITY AS d(doc, ord)
JOIN release_documents rd ON rd.release_id = n.id AND rd.sort_index = (d.ord - 1)::int;
--> statement-breakpoint
INSERT INTO document_contacts (document_id, language_id, sort_index, information)
SELECT rd.id, 4105, (c.ord - 1)::int, concat_ws(E'\n', NULLIF(c.contact->>'title', ''), NULLIF(c.contact->>'details', ''))
FROM releases r JOIN news_releases n ON n.key = r.key
CROSS JOIN LATERAL jsonb_array_elements(r.content->'documents') WITH ORDINALITY AS d(doc, ord)
JOIN release_documents rd ON rd.release_id = n.id AND rd.sort_index = (d.ord - 1)::int
CROSS JOIN LATERAL jsonb_array_elements(d.doc->'contacts') WITH ORDINALITY AS c(contact, ord);
--> statement-breakpoint
INSERT INTO release_categories (release_id, kind, key)
SELECT DISTINCT n.id, k.kind, lower(k.key)
FROM releases r JOIN news_releases n ON n.key = r.key
CROSS JOIN LATERAL (
  SELECT 'ministries' AS kind, jsonb_array_elements_text(r.content->'ministryKeys') AS key
  UNION ALL SELECT 'sectors', jsonb_array_elements_text(r.content->'sectorKeys')
  UNION ALL SELECT 'themes', jsonb_array_elements_text(r.content->'themeKeys')
  UNION ALL SELECT 'tags', jsonb_array_elements_text(r.content->'tagKeys')
) k;

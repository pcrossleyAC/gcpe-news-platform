-- Seeds a default set of English page types, but only when page_types has no rows at all —
-- a fresh install (no legacy import run yet) would otherwise show the staff app's New release
-- screen with no page types to choose from. Titles for Release and Story are those in use on
-- news.gov.bc.ca (api.news.gov.bc.ca, 2026-10-05); Factsheet / Media Advisory and all layouts
-- are working assumptions pending open question Q20. The importer replaces these with the
-- legacy list, so this never touches an already-imported (or already-seeded) table, and
-- re-running this migration is a no-op.
INSERT INTO page_types (page_title, language_id, release_type, sort_order, layout, page_image_id)
SELECT v.page_title, 4105, v.release_type, v.sort_order, v.layout, NULL
FROM (VALUES
  ('News Release', 'release', 1, 'formal'),
  ('Information Bulletin', 'release', 2, 'formal'),
  ('Statement', 'release', 3, 'informal'),
  ('Backgrounder', 'release', 4, 'informal'),
  ('Traffic Advisory', 'release', 5, 'formal'),
  ('Story', 'story', 1, 'informal'),
  ('Factsheet', 'factsheet', 1, 'informal'),
  ('Media Advisory', 'advisory', 1, 'formal')
) AS v(page_title, release_type, sort_order, layout)
WHERE NOT EXISTS (SELECT 1 FROM page_types);

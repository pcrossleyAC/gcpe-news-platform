-- Releases already on the site when the `live` column arrived (Phase 2 copies are 'published';
-- 'publishing'/'unpublishing' are still live until the publisher finishes with them).
UPDATE news_releases SET live = true WHERE status IN ('published', 'publishing', 'unpublishing');

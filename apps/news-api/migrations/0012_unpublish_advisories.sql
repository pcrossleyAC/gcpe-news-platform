-- Suite review R1 (owner, 2026-10-31): an Advisory is never on the public site (legacy NewModel.cs;
-- NRMS's publishFlags.toWeb is false for every Advisory and for nothing else). Builds before this
-- one stored published Advisories as public posts. Take each one off the site the way an unpublish
-- does: is_published off, its semantic rows gone, and a post.unpublished change so the public site
-- drops the page and rebuilds the listings, feeds and sitemap that carried it. Safe to re-run.
WITH unpublished AS (
  UPDATE posts SET is_published = false WHERE kind = 'advisories' AND is_published RETURNING key
), embeddings AS (
  DELETE FROM post_embeddings WHERE post_key IN (SELECT key FROM unpublished)
), related AS (
  DELETE FROM post_related WHERE post_key IN (SELECT key FROM unpublished)
)
INSERT INTO changes (kind, key) SELECT 'post.unpublished', key FROM unpublished ORDER BY key;

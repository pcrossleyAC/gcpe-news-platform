-- Suite review R1 (owner, 2026-10-31): an Advisory is never on the public site (legacy NewModel.cs;
-- NRMS's publishFlags.toWeb is false for every Advisory and for nothing else). Builds before this
-- one stored published Advisories as public posts. Take each one off the site the way an unpublish
-- does (projections.ts unpublishRelease): is_published off, its semantic rows gone, and a
-- post.unpublished change so the public site drops the page and rebuilds the listings, feeds and
-- sitemap that carried it, plus a post.upserted change for each page whose related band may link
-- it (relatedBandReferrers, the same query). Safe to re-run: a second run finds nothing to do.
CREATE TEMP TABLE adv_unpublished ON COMMIT DROP AS
  WITH u AS (UPDATE posts SET is_published = false WHERE kind = 'advisories' AND is_published RETURNING key)
  SELECT key FROM u;--> statement-breakpoint
CREATE TEMP TABLE adv_referrers ON COMMIT DROP AS
  WITH gone AS (
    SELECT p.key, p.lead_ministry_key, p.index_keys, p.publish_date FROM posts p WHERE p.key IN (SELECT key FROM adv_unpublished)
  ), semantic AS (
    SELECT r.post_key AS key FROM post_related r
    WHERE EXISTS (SELECT 1 FROM unnest(r.related_keys) k JOIN gone g ON lower(k) = lower(g.key))
  ), text_mode AS (
    SELECT w.key FROM gone g
    CROSS JOIN LATERAL unnest(g.index_keys) AS t(ik)
    CROSS JOIN LATERAL (
      SELECT p.key FROM posts p
      WHERE p.is_published AND p.index_keys @> ARRAY[t.ik] AND lower(p.lead_ministry_key) = lower(g.lead_ministry_key)
        AND p.publish_date >= g.publish_date AND lower(p.key) <> lower(g.key)
      ORDER BY p.publish_date, p.key LIMIT 5
    ) w
    WHERE t.ik LIKE 'tags:%'
  ), fallback AS (
    SELECT w.key FROM gone g
    CROSS JOIN LATERAL unnest(g.index_keys) AS m(ik)
    CROSS JOIN LATERAL (
      SELECT p.key, p.lead_ministry_key FROM posts p
      WHERE p.is_published AND p.index_keys @> ARRAY[m.ik] AND p.publish_date >= g.publish_date AND lower(p.key) <> lower(g.key)
      ORDER BY p.publish_date, p.key LIMIT 4
    ) w
    WHERE m.ik LIKE 'ministries:%' AND lower(w.lead_ministry_key) = substr(m.ik, 12)
  )
  SELECT p.key FROM posts p
  WHERE p.is_published
    AND p.key IN (SELECT key FROM semantic UNION SELECT key FROM text_mode UNION SELECT key FROM fallback)
    AND lower(p.key) NOT IN (SELECT lower(key) FROM gone);--> statement-breakpoint
DELETE FROM post_embeddings WHERE post_key IN (SELECT key FROM adv_unpublished);--> statement-breakpoint
DELETE FROM post_related WHERE post_key IN (SELECT key FROM adv_unpublished);--> statement-breakpoint
-- The change feed's lock (changes.ts CHANGES_LOCK = [0x67637065, 4]), taken last as every writer
-- takes it, and held to commit: ids then become visible in id order, so no reader's cursor can
-- pass these rows before they commit.
SELECT pg_advisory_xact_lock(1734570085, 4);--> statement-breakpoint
INSERT INTO changes (kind, key)
  SELECT kind, key FROM (
    SELECT 0 AS o, 'post.unpublished' AS kind, key FROM adv_unpublished
    UNION ALL
    SELECT 1, 'post.upserted', key FROM adv_referrers
  ) c ORDER BY o, key;

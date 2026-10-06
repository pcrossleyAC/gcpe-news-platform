-- Seeds the approve-time counters from releases that already hold numbers (the Phase 2 copy in
-- 0004; later, the legacy importer), so the next approval continues after them instead of
-- colliding with an existing reference or key. GREATEST keeps a counter from ever going down,
-- so this is safe to re-run.
--
-- 'news'     (year 0, ministry '')  ← max n of references 'NEWS-n'
-- 'year'     (per year, ministry '') ← max m of keys '{year}{ABBR}{n:0000}-{m:000000}'
-- 'ministry' (per year, lead ministry, '' for ADVIS) ← max n of those keys
INSERT INTO number_counters (scope, year, ministry, last_value)
SELECT 'news', 0, '', max(substring(reference FROM 6)::int)
FROM news_releases
WHERE reference ~ '^NEWS-[0-9]+$'
HAVING count(*) > 0
ON CONFLICT (scope, year, ministry) DO UPDATE SET last_value = GREATEST(number_counters.last_value, excluded.last_value);
--> statement-breakpoint
INSERT INTO number_counters (scope, year, ministry, last_value)
SELECT 'year', substring(key FROM 1 FOR 4)::int, '', max(substring(key FROM '-([0-9]{6})$')::int)
FROM news_releases
WHERE key ~ '^[0-9]{4}[A-Z]+[0-9]{4}-[0-9]{6}$'
GROUP BY 2
ON CONFLICT (scope, year, ministry) DO UPDATE SET last_value = GREATEST(number_counters.last_value, excluded.last_value);
--> statement-breakpoint
INSERT INTO number_counters (scope, year, ministry, last_value)
SELECT 'ministry', y, m, max(n)
FROM (
  SELECT
    substring(key FROM 1 FOR 4)::int AS y,
    CASE WHEN substring(key FROM '^[0-9]{4}([A-Z]+)[0-9]{4}-') = 'ADVIS' THEN '' ELSE lower(lead_ministry_key) END AS m,
    substring(key FROM '([0-9]{4})-[0-9]{6}$')::int AS n
  FROM news_releases
  WHERE key ~ '^[0-9]{4}[A-Z]+[0-9]{4}-[0-9]{6}$'
) k
WHERE m IS NOT NULL
GROUP BY y, m
ON CONFLICT (scope, year, ministry) DO UPDATE SET last_value = GREATEST(number_counters.last_value, excluded.last_value);

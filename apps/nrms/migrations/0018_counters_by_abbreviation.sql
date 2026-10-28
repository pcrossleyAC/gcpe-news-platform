-- Release-number counters are keyed by the printed abbreviation (upper-case), not by ministry key
-- (new-government spec N11, ruling NG-R11): when a successor takes HLTH it continues HLTH's count, and an
-- abbreviation that is freed and re-used never restarts at 0001 within a year.
-- Safe on a populated database and idempotent: it only GREATEST-merges into abbreviation rows, then drops
-- the key-keyed rows it has folded in (a second run finds none).
INSERT INTO number_counters (scope, year, ministry, last_value)
SELECT 'ministry', c.year, upper(trim(o.abbreviation)), max(c.last_value)
FROM number_counters c JOIN organizations o ON o.key = c.ministry
WHERE c.scope = 'ministry' AND c.ministry <> '' AND coalesce(trim(o.abbreviation), '') <> ''
GROUP BY c.year, upper(trim(o.abbreviation))
ON CONFLICT (scope, year, ministry) DO UPDATE SET last_value = GREATEST(number_counters.last_value, EXCLUDED.last_value);
--> statement-breakpoint
-- Releases already numbered also pin the counter, whatever ministry key their counter was under
-- (their key is {year}{ABBR}{n:0000}-{m:000000}; ADVIS counts under '' as approve does).
INSERT INTO number_counters (scope, year, ministry, last_value)
SELECT 'ministry', k.year, k.abbr, max(k.n)
FROM (
  SELECT substring(key FROM 1 FOR 4)::int AS year,
         CASE WHEN upper(substring(key FROM '^\d{4}(.+)\d{4}-\d{6}$')) = 'ADVIS' THEN '' ELSE upper(substring(key FROM '^\d{4}(.+)\d{4}-\d{6}$')) END AS abbr,
         substring(key FROM '(\d{4})-\d{6}$')::int AS n
  FROM news_releases WHERE key ~ '^\d{4}.+\d{4}-\d{6}$'
) k
GROUP BY k.year, k.abbr
ON CONFLICT (scope, year, ministry) DO UPDATE SET last_value = GREATEST(number_counters.last_value, EXCLUDED.last_value);
--> statement-breakpoint
DELETE FROM number_counters c
USING organizations o
WHERE c.scope = 'ministry' AND c.ministry <> '' AND o.key = c.ministry
  AND coalesce(trim(o.abbreviation), '') <> '' AND c.ministry <> upper(trim(o.abbreviation));

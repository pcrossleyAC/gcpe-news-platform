/*
  03 — Hub releases (NRMS). Run in Gcpe.Hub. Read-only; returns no personal data (contact blocks,
  log text and user names are counted, never returned). See README.md.
  Feeds the Phase 3 importer rehearsal and open questions Q6, Q10–Q13, Q19, Q20 and C35.
*/
USE [Gcpe.Hub];   -- change if your Hub database is named differently
SET NOCOUNT ON;
SET TRANSACTION ISOLATION LEVEL READ UNCOMMITTED;

-- 3.1 Releases per year and type (Q6: is "Update" still used?).
SELECT YEAR(ISNULL(PublishDateTime, ReleaseDateTime)) AS yr, ReleaseType, COUNT(*) AS releases,
       SUM(CAST(IsPublished AS INT)) AS published, SUM(CAST(IsActive AS INT)) AS active
FROM dbo.NewsRelease
GROUP BY YEAR(ISNULL(PublishDateTime, ReleaseDateTime)), ReleaseType
ORDER BY yr, ReleaseType;

-- 3.2 Status flag combinations (C3 maps these to one status).
SELECT IsCommitted, IsPublished, IsActive, PublishOptions,
       CASE WHEN PublishDateTime IS NULL THEN 'none' WHEN PublishDateTime > SYSDATETIMEOFFSET() THEN 'future' ELSE 'past' END AS publish_time,
       CASE WHEN Reference = '' THEN 'no' ELSE 'yes' END AS has_reference,
       COUNT(*) AS releases
FROM dbo.NewsRelease
GROUP BY IsCommitted, IsPublished, IsActive, PublishOptions,
         CASE WHEN PublishDateTime IS NULL THEN 'none' WHEN PublishDateTime > SYSDATETIMEOFFSET() THEN 'future' ELSE 'past' END,
         CASE WHEN Reference = '' THEN 'no' ELSE 'yes' END
ORDER BY releases DESC;

-- 3.3 Releases waiting to go out right now (what cutover must carry over live).
SELECT ReleaseType, IsCommitted, IsPublished, COUNT(*) AS releases,
       MIN(PublishDateTime) AS earliest, MAX(PublishDateTime) AS latest
FROM dbo.NewsRelease
WHERE IsActive = 1 AND (IsPublished = 0 OR PublishDateTime > SYSDATETIMEOFFSET())
GROUP BY ReleaseType, IsCommitted, IsPublished;

-- 3.4 Keys shared across release types, ignoring case (C35), and blank/odd keys.
SELECT LOWER(r.[Key]) AS key_lower, COUNT(*) AS releases, COUNT(DISTINCT r.ReleaseType) AS types,
       STUFF((SELECT ',' + CAST(r2.ReleaseType AS VARCHAR(5)) FROM dbo.NewsRelease r2
               WHERE LOWER(r2.[Key]) = LOWER(r.[Key]) FOR XML PATH('')), 1, 1, '') AS release_types
FROM dbo.NewsRelease r
GROUP BY LOWER(r.[Key]) HAVING COUNT(*) > 1
ORDER BY releases DESC;
SELECT SUM(CASE WHEN [Key] = '' THEN 1 ELSE 0 END) AS blank_keys,
       SUM(CASE WHEN [Key] LIKE '% %' THEN 1 ELSE 0 END) AS keys_with_spaces,
       SUM(CASE WHEN [Key] COLLATE Latin1_General_BIN LIKE '%[^A-Za-z0-9-]%' THEN 1 ELSE 0 END) AS keys_with_other_chars,
       MAX(LEN([Key])) AS longest_key
FROM dbo.NewsRelease;

-- 3.5 Reference numbers: duplicates and format (C4).
SELECT Reference, COUNT(*) AS releases FROM dbo.NewsRelease
WHERE Reference <> '' GROUP BY Reference HAVING COUNT(*) > 1;
SELECT LEFT(Reference, 4) AS prefix, COUNT(*) AS releases, MIN(Reference) AS first_ref, MAX(Reference) AS last_ref
FROM dbo.NewsRelease WHERE Reference <> '' GROUP BY LEFT(Reference, 4) ORDER BY releases DESC;

-- 3.6 Time zones (Q19). ReleaseDateTime is a plain DATETIME; PublishDateTime carries an offset.
--     The offsets in use, and how far apart the two fields are.
SELECT DATEPART(TZOFFSET, PublishDateTime) AS publish_offset_minutes, COUNT(*) AS releases
FROM dbo.NewsRelease WHERE PublishDateTime IS NOT NULL
GROUP BY DATEPART(TZOFFSET, PublishDateTime) ORDER BY releases DESC;
SELECT DATEDIFF(minute, CAST(SWITCHOFFSET(PublishDateTime, '+00:00') AS DATETIME), ReleaseDateTime) AS release_minus_publish_utc_minutes,
       COUNT(*) AS releases
FROM dbo.NewsRelease
WHERE PublishDateTime IS NOT NULL AND ReleaseDateTime IS NOT NULL
GROUP BY DATEDIFF(minute, CAST(SWITCHOFFSET(PublishDateTime, '+00:00') AS DATETIME), ReleaseDateTime)
HAVING COUNT(*) >= 5
ORDER BY releases DESC;

-- 3.7 Links to the calendar (Forecast, Q13) and other per-release fields.
SELECT COUNT(*) AS releases,
       SUM(CASE WHEN ActivityId IS NOT NULL THEN 1 ELSE 0 END) AS with_activity,
       SUM(CAST(HasMediaAssets AS INT)) AS with_media_assets,
       SUM(CAST(HasTranslations AS INT)) AS with_translations,
       SUM(CASE WHEN AssetUrl <> '' THEN 1 ELSE 0 END) AS with_asset_url,
       SUM(CASE WHEN RedirectUrl <> '' THEN 1 ELSE 0 END) AS with_redirect,
       SUM(CASE WHEN Keywords <> '' THEN 1 ELSE 0 END) AS with_keywords,
       SUM(CASE WHEN NodSubscribers IS NOT NULL THEN 1 ELSE 0 END) AS with_nod_count,
       SUM(CASE WHEN MediaSubscribers IS NOT NULL THEN 1 ELSE 0 END) AS with_media_count
FROM dbo.NewsRelease;

-- 3.8 Asset URL hosts (Q9: any Facebook links in old data?).
SELECT LOWER(SUBSTRING(AssetUrl, CHARINDEX('//', AssetUrl) + 2,
         CHARINDEX('/', AssetUrl + '/', CHARINDEX('//', AssetUrl) + 2) - CHARINDEX('//', AssetUrl) - 2)) AS asset_host,
       COUNT(*) AS releases
FROM dbo.NewsRelease WHERE AssetUrl LIKE '%//%'
GROUP BY LOWER(SUBSTRING(AssetUrl, CHARINDEX('//', AssetUrl) + 2,
         CHARINDEX('/', AssetUrl + '/', CHARINDEX('//', AssetUrl) + 2) - CHARINDEX('//', AssetUrl) - 2))
ORDER BY releases DESC;

-- 3.9 Languages per release and per document (Q10).
SELECT LanguageId, COUNT(*) AS release_language_rows,
       SUM(CASE WHEN Location <> '' THEN 1 ELSE 0 END) AS with_location,
       SUM(CASE WHEN Summary <> '' THEN 1 ELSE 0 END) AS with_summary,
       SUM(CASE WHEN SocialMediaHeadline <> '' THEN 1 ELSE 0 END) AS with_social_headline,
       MAX(LEN(Location)) AS max_location, MAX(LEN(Summary)) AS max_summary
FROM dbo.NewsReleaseLanguage GROUP BY LanguageId;
SELECT LanguageId, COUNT(*) AS document_language_rows FROM dbo.NewsReleaseDocumentLanguage GROUP BY LanguageId;

-- 3.10 Documents per release, layouts, and contact blocks (counted, not returned).
SELECT documents, COUNT(*) AS releases FROM
  (SELECT r.Id, COUNT(d.Id) AS documents FROM dbo.NewsRelease r
     LEFT JOIN dbo.NewsReleaseDocument d ON d.ReleaseId = r.Id GROUP BY r.Id) x
GROUP BY documents ORDER BY documents;
SELECT PageLayout, COUNT(*) AS documents FROM dbo.NewsReleaseDocument GROUP BY PageLayout;
SELECT contacts, COUNT(*) AS document_languages FROM
  (SELECT dl.DocumentId, dl.LanguageId, COUNT(c.SortIndex) AS contacts
     FROM dbo.NewsReleaseDocumentLanguage dl
     LEFT JOIN dbo.NewsReleaseDocumentContact c ON c.DocumentId = dl.DocumentId AND c.LanguageId = dl.LanguageId
    GROUP BY dl.DocumentId, dl.LanguageId) x
GROUP BY contacts ORDER BY contacts;
SELECT MAX(LEN(Information)) AS longest_contact_block FROM dbo.NewsReleaseDocumentContact;

-- 3.11 Field lengths and empties (checks the new limits and the empty-body rule, C7).
SELECT MAX(LEN(PageTitle)) AS max_page_title, MAX(LEN(Headline)) AS max_headline,
       MAX(LEN(Subheadline)) AS max_subheadline, MAX(LEN(Organizations)) AS max_organizations,
       MAX(LEN(Byline)) AS max_byline, MAX(DATALENGTH(BodyHtml) / 2) AS max_body_chars,
       AVG(DATALENGTH(BodyHtml) / 2) AS avg_body_chars,
       SUM(CASE WHEN Headline = '' THEN 1 ELSE 0 END) AS empty_headlines,
       SUM(CASE WHEN BodyHtml IS NULL OR LTRIM(RTRIM(CAST(BodyHtml AS NVARCHAR(4000)))) = '' THEN 1 ELSE 0 END) AS empty_bodies,
       SUM(CASE WHEN PageImageId IS NULL THEN 1 ELSE 0 END) AS no_page_image
FROM dbo.NewsReleaseDocumentLanguage;

-- 3.12 Page titles actually used, per release type (Q20).
SELECT r.ReleaseType, dl.LanguageId, dl.PageTitle, COUNT(*) AS documents,
       MAX(r.PublishDateTime) AS last_used
FROM dbo.NewsReleaseDocumentLanguage dl
JOIN dbo.NewsReleaseDocument d ON d.Id = dl.DocumentId
JOIN dbo.NewsRelease r ON r.Id = d.ReleaseId
GROUP BY r.ReleaseType, dl.LanguageId, dl.PageTitle
ORDER BY r.ReleaseType, dl.LanguageId, documents DESC;

-- 3.13 HEAVY — what's inside the body HTML (paste filter, renderer, C8). Counts only.
SELECT COUNT(*) AS bodies,
       SUM(CASE WHEN BodyHtml LIKE '%<img%' THEN 1 ELSE 0 END) AS with_img,
       SUM(CASE WHEN BodyHtml LIKE '%<iframe%' THEN 1 ELSE 0 END) AS with_iframe,
       SUM(CASE WHEN BodyHtml LIKE '%<script%' THEN 1 ELSE 0 END) AS with_script,
       SUM(CASE WHEN BodyHtml LIKE '%<table%' THEN 1 ELSE 0 END) AS with_table,
       SUM(CASE WHEN BodyHtml LIKE '%style=%' THEN 1 ELSE 0 END) AS with_inline_style,
       SUM(CASE WHEN BodyHtml LIKE '%class=%' THEN 1 ELSE 0 END) AS with_class,
       SUM(CASE WHEN BodyHtml LIKE '%<h[1-6]%' THEN 1 ELSE 0 END) AS with_headings,
       SUM(CASE WHEN BodyHtml LIKE '%<ol%' OR BodyHtml LIKE '%<ul%' THEN 1 ELSE 0 END) AS with_lists,
       SUM(CASE WHEN BodyHtml LIKE '%<a %' THEN 1 ELSE 0 END) AS with_links,
       SUM(CASE WHEN BodyHtml LIKE '%mso-%' OR BodyHtml LIKE '%MsoNormal%' THEN 1 ELSE 0 END) AS with_word_markup,
       SUM(CASE WHEN BodyHtml LIKE '%&nbsp;%' THEN 1 ELSE 0 END) AS with_nbsp,
       SUM(CASE WHEN BodyHtml LIKE '%youtube%' THEN 1 ELSE 0 END) AS mentions_youtube,
       SUM(CASE WHEN BodyHtml LIKE '%flickr%' THEN 1 ELSE 0 END) AS mentions_flickr
FROM dbo.NewsReleaseDocumentLanguage;

-- 3.14 Published copies (Q12).
SELECT MimeType, COUNT(*) AS copies, COUNT(DISTINCT ReleaseId) AS releases,
       MIN(PublishDateTime) AS first_copy, MAX(PublishDateTime) AS last_copy
FROM dbo.NewsReleaseHistory GROUP BY MimeType;

-- 3.15 HEAVY — files stored in the database (Q13): blob counts and sizes by what uses them.
SELECT 'page image' AS used_by, COUNT(*) AS blobs, CAST(SUM(DATALENGTH(b.Data)) / 1048576.0 AS DECIMAL(12,1)) AS mb
FROM dbo.NewsReleaseImage i JOIN dbo.Blob b ON b.Id = i.BlobId
UNION ALL
SELECT 'published copy', COUNT(*), CAST(SUM(DATALENGTH(b.Data)) / 1048576.0 AS DECIMAL(12,1))
FROM dbo.NewsReleaseHistory h JOIN dbo.Blob b ON b.Id = h.BlobId
UNION ALL
SELECT 'all blobs', COUNT(*), CAST(SUM(DATALENGTH(Data)) / 1048576.0 AS DECIMAL(12,1)) FROM dbo.Blob;

-- 3.16 Release log volume (log text and users are not returned).
SELECT YEAR([DateTime]) AS yr, COUNT(*) AS log_entries, COUNT(DISTINCT ReleaseId) AS releases,
       SUM(CASE WHEN UserId IS NULL THEN 1 ELSE 0 END) AS without_user
FROM dbo.NewsReleaseLog GROUP BY YEAR([DateTime]) ORDER BY yr;
-- The kinds of log entry: the first two words of each description (no names follow them).
SELECT LEFT(Description, CHARINDEX(' ', Description + ' ', CHARINDEX(' ', Description + ' ') + 1)) AS entry_start,
       COUNT(*) AS entries
FROM dbo.NewsReleaseLog
GROUP BY LEFT(Description, CHARINDEX(' ', Description + ' ', CHARINDEX(' ', Description + ' ') + 1))
HAVING COUNT(*) >= 20
ORDER BY entries DESC;

-- 3.17 Categories and media lists per release.
SELECT 'ministries' AS kind, n, COUNT(*) AS releases FROM
  (SELECT r.Id, COUNT(m.MinistryId) AS n FROM dbo.NewsRelease r LEFT JOIN dbo.NewsReleaseMinistry m ON m.ReleaseId = r.Id GROUP BY r.Id) x GROUP BY n
UNION ALL
SELECT 'sectors', n, COUNT(*) FROM
  (SELECT r.Id, COUNT(s.SectorId) AS n FROM dbo.NewsRelease r LEFT JOIN dbo.NewsReleaseSector s ON s.ReleaseId = r.Id GROUP BY r.Id) x GROUP BY n
UNION ALL
SELECT 'media lists', n, COUNT(*) FROM
  (SELECT r.Id, COUNT(d.MediaDistributionListId) AS n FROM dbo.NewsRelease r LEFT JOIN dbo.NewsReleaseMediaDistribution d ON d.ReleaseId = r.Id GROUP BY r.Id) x GROUP BY n
ORDER BY kind, n;
SELECT COUNT(*) AS releases_without_lead_ministry FROM dbo.NewsRelease
WHERE MinistryId IS NULL AND ReleaseType <> 4;   -- type numbers per 3.1; adjust if Advisory isn't 4

-- 3.18 Orphans (rows the importer would trip over).
SELECT 'document without release' AS problem, COUNT(*) AS n FROM dbo.NewsReleaseDocument d
  WHERE NOT EXISTS (SELECT 1 FROM dbo.NewsRelease r WHERE r.Id = d.ReleaseId)
UNION ALL SELECT 'document language without document', COUNT(*) FROM dbo.NewsReleaseDocumentLanguage dl
  WHERE NOT EXISTS (SELECT 1 FROM dbo.NewsReleaseDocument d WHERE d.Id = dl.DocumentId)
UNION ALL SELECT 'release with no documents', COUNT(*) FROM dbo.NewsRelease r
  WHERE NOT EXISTS (SELECT 1 FROM dbo.NewsReleaseDocument d WHERE d.ReleaseId = r.Id)
UNION ALL SELECT 'release with no English document', COUNT(*) FROM dbo.NewsRelease r
  WHERE NOT EXISTS (SELECT 1 FROM dbo.NewsReleaseDocument d JOIN dbo.NewsReleaseDocumentLanguage dl ON dl.DocumentId = d.Id
                     WHERE d.ReleaseId = r.Id AND dl.LanguageId = 4105)
UNION ALL SELECT 'page image id with no image', COUNT(*) FROM dbo.NewsReleaseDocumentLanguage dl
  WHERE dl.PageImageId IS NOT NULL AND NOT EXISTS (SELECT 1 FROM dbo.NewsReleaseImage i WHERE i.Id = dl.PageImageId)
UNION ALL SELECT 'activity id with no activity', COUNT(*) FROM dbo.NewsRelease r
  WHERE r.ActivityId IS NOT NULL AND NOT EXISTS (SELECT 1 FROM calendar.Activity a WHERE a.Id = r.ActivityId)
UNION ALL SELECT 'top/feature pointing at a missing release', COUNT(*) FROM dbo.Ministry m
  WHERE (m.TopReleaseId IS NOT NULL AND NOT EXISTS (SELECT 1 FROM dbo.NewsRelease r WHERE r.Id = m.TopReleaseId))
     OR (m.FeatureReleaseId IS NOT NULL AND NOT EXISTS (SELECT 1 FROM dbo.NewsRelease r WHERE r.Id = m.FeatureReleaseId));

-- 3.19 Audience sizes recorded at publish time (Q21): the biggest sends, and per month.
SELECT TOP 20 [Key], ReleaseType, PublishDateTime, NodSubscribers, MediaSubscribers
FROM dbo.NewsRelease
WHERE IsPublished = 1 AND PublishDateTime >= DATEADD(year, -2, SYSDATETIMEOFFSET())
ORDER BY ISNULL(NodSubscribers, 0) + ISNULL(MediaSubscribers, 0) DESC;
SELECT YEAR(PublishDateTime) AS yr, MONTH(PublishDateTime) AS mo, COUNT(*) AS releases,
       MAX(NodSubscribers) AS max_nod, AVG(NodSubscribers * 1.0) AS avg_nod,
       MAX(MediaSubscribers) AS max_media, AVG(MediaSubscribers * 1.0) AS avg_media
FROM dbo.NewsRelease
WHERE IsPublished = 1 AND PublishDateTime >= DATEADD(year, -2, SYSDATETIMEOFFSET())
GROUP BY YEAR(PublishDateTime), MONTH(PublishDateTime)
ORDER BY yr, mo;

-- 3.20 Media lists used, last 2 years.
SELECT m.[Key], m.DisplayName, m.IsActive, COUNT(r.Id) AS releases_2y
FROM dbo.MediaDistributionList m
LEFT JOIN dbo.NewsReleaseMediaDistribution d ON d.MediaDistributionListId = m.Id
LEFT JOIN dbo.NewsRelease r ON r.Id = d.ReleaseId AND r.PublishDateTime >= DATEADD(year, -2, SYSDATETIMEOFFSET())
GROUP BY m.[Key], m.DisplayName, m.IsActive
ORDER BY releases_2y DESC;

-- 3.21 Releases per hour of day and day of week, last 2 years (publisher load, change freeze).
SELECT DATEPART(weekday, PublishDateTime) AS weekday_1_sunday, DATEPART(hour, PublishDateTime) AS hour_local,
       COUNT(*) AS releases
FROM dbo.NewsRelease
WHERE IsPublished = 1 AND PublishDateTime >= DATEADD(year, -2, SYSDATETIMEOFFSET())
GROUP BY DATEPART(weekday, PublishDateTime), DATEPART(hour, PublishDateTime)
ORDER BY weekday_1_sunday, hour_local;

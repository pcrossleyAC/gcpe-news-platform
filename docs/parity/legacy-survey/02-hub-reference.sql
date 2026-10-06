/*
  02 — Hub reference data (non-personal lookups the new system seeds or maps). Run in Gcpe.Hub.
  Read-only; returns no personal data. See README.md.
*/
USE [Gcpe.Hub];   -- change if your Hub database is named differently
SET NOCOUNT ON;
SET TRANSACTION ISOLATION LEVEL READ UNCOMMITTED;

-- 2.1 Ministries. Ministers are public office holders; emails and phone numbers are left out.
SELECT Id, [Key], DisplayName, Abbreviation, SortOrder, IsActive, ParentId, MinistryUrl,
       MinisterName, DisplayAdditionalName, MinisterPhotoUrl, TwitterUsername, FlickrUrl,
       YoutubeUrl, AudioUrl, TopReleaseId, FeatureReleaseId, [Timestamp],
       LEN(MinisterPageHtml) AS minister_page_html_len, LEN(MinisterSummary) AS minister_summary_len,
       LEN(MiscHtml) AS misc_html_len, LEN(MiscRightHtml) AS misc_right_html_len,
       LEN(FacebookEmbedHtml) AS facebook_embed_len, LEN(YoutubeEmbedHtml) AS youtube_embed_len,
       LEN(AudioEmbedHtml) AS audio_embed_len,
       CASE WHEN ContactUserId IS NULL THEN 0 ELSE 1 END AS has_contact_user,
       CASE WHEN SecondContactUserId IS NULL THEN 0 ELSE 1 END AS has_second_contact_user,
       EodFinalizedDateTime, EodLastRunDateTime
FROM dbo.Ministry ORDER BY SortOrder, DisplayName;

-- 2.2 Sectors, themes, tags.
SELECT Id, [Key], DisplayName, SortOrder, IsActive, TopReleaseId, FeatureReleaseId, [Timestamp],
       TwitterUsername, FlickrUrl, YoutubeUrl, AudioUrl, LEN(MiscHtml) AS misc_html_len
FROM dbo.Sector ORDER BY SortOrder, DisplayName;
SELECT Id, [Key], DisplayName, SortOrder, IsActive, TopReleaseId, FeatureReleaseId, [Timestamp]
FROM dbo.Theme ORDER BY SortOrder, DisplayName;
SELECT Id, [Key], DisplayName, SortOrder, IsActive FROM dbo.Tag ORDER BY SortOrder, DisplayName;

-- 2.3 Per-language names and the ministry/sector link tables.
SELECT * FROM dbo.Language ORDER BY SortOrder;
SELECT * FROM dbo.SectorLanguage;
SELECT * FROM dbo.MinistryLanguage;
SELECT * FROM dbo.MinistrySector;
SELECT * FROM dbo.MinistryTopic;
SELECT * FROM dbo.MinistryService;
SELECT * FROM dbo.MinistryNewsletter;

-- 2.4 How many releases use each ministry/sector/theme/tag (spot dead or never-used ones).
SELECT 'ministry' AS kind, m.[Key], m.IsActive, COUNT(r.ReleaseId) AS releases FROM dbo.Ministry m
  LEFT JOIN dbo.NewsReleaseMinistry r ON r.MinistryId = m.Id GROUP BY m.[Key], m.IsActive
UNION ALL
SELECT 'sector', s.[Key], s.IsActive, COUNT(r.ReleaseId) FROM dbo.Sector s
  LEFT JOIN dbo.NewsReleaseSector r ON r.SectorId = s.Id GROUP BY s.[Key], s.IsActive
UNION ALL
SELECT 'theme', t.[Key], t.IsActive, COUNT(r.ReleaseId) FROM dbo.Theme t
  LEFT JOIN dbo.NewsReleaseTheme r ON r.ThemeId = t.Id GROUP BY t.[Key], t.IsActive
UNION ALL
SELECT 'tag', g.[Key], g.IsActive, COUNT(r.ReleaseId) FROM dbo.Tag g
  LEFT JOIN dbo.NewsReleaseTag r ON r.TagId = g.Id GROUP BY g.[Key], g.IsActive
ORDER BY kind, releases DESC;

-- 2.5 Media distribution lists (names only).
SELECT Id, [Key], DisplayName, SortOrder, IsActive FROM dbo.MediaDistributionList ORDER BY SortOrder;

-- 2.6 Release types and their page titles per language (Q20). Save as-is.
SELECT ReleaseType, LanguageId, SortOrder, PageTitle, PageLayout, PageImageId
FROM dbo.NewsReleaseType ORDER BY ReleaseType, LanguageId, SortOrder;

-- 2.7 Page images (Q11): every image, its alternate names and how often each is used.
SELECT i.Id, i.SortOrder, i.Name, i.MimeType,
       (SELECT COUNT(*) FROM dbo.NewsReleaseDocumentLanguage dl WHERE dl.PageImageId = i.Id) AS document_uses,
       (SELECT COUNT(*) FROM dbo.NewsReleaseType rt WHERE rt.PageImageId = i.Id) AS type_defaults
FROM dbo.NewsReleaseImage i ORDER BY i.SortOrder;
SELECT * FROM dbo.NewsReleaseImageLanguage;

-- 2.8 Application settings (secret-looking values masked). Answers part of Q13 and Forecast.
SELECT SettingName,
       CASE WHEN SettingName LIKE '%pass%' OR SettingName LIKE '%pwd%' OR SettingName LIKE '%secret%'
              OR SettingName LIKE '%key%' OR SettingName LIKE '%token%' OR SettingName LIKE '%connection%'
              OR SettingName LIKE '%credential%' OR SettingValue LIKE '%AccountKey=%' OR SettingValue LIKE '%Password=%'
            THEN '***' ELSE SettingValue END AS SettingValue,
       LEN(SettingValue) AS value_length
FROM dbo.ApplicationSetting ORDER BY SettingName;

-- 2.9 Website section content (public): carousel, slides, resource links.
SELECT * FROM dbo.Carousel;
SELECT * FROM dbo.CarouselSlide;
SELECT Id, Headline, Summary, ActionUrl, FacebookPostUrl, Justify, [Timestamp],
       DATALENGTH([Image]) AS image_bytes
FROM dbo.Slide;
SELECT * FROM dbo.ResourceLink ORDER BY SortIndex;

-- 2.10 Collections (release groupings / government terms, C11).
SELECT * FROM dbo.NewsReleaseCollection;
SELECT CollectionId, COUNT(*) AS releases, MIN(PublishDateTime) AS first_publish, MAX(PublishDateTime) AS last_publish
FROM dbo.NewsRelease GROUP BY CollectionId;

-- 2.11 Hub users: counts only (staff names are not returned).
SELECT IsActive, COUNT(*) AS users FROM dbo.[User] GROUP BY IsActive;

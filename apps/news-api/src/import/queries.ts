const PUBLISHED = "r.IsCommitted = 1 AND r.IsPublished = 1 AND r.IsActive = 1";
const year = (y: number) => `${PUBLISHED} AND YEAR(r.PublishDateTime) = ${Math.trunc(y)}`;

export const Q_RELEASE_YEARS = `-- name: releaseYears
SELECT DISTINCT YEAR(r.PublishDateTime) AS [Year] FROM dbo.NewsRelease r WHERE ${PUBLISHED} AND r.PublishDateTime IS NOT NULL`;

export const qReleases = (y: number) => `-- name: releases:${y}
SELECT r.Id, r.[Key], r.ReleaseType, r.Reference, r.AtomId, r.PublishDateTime, m.[Key] AS LeadMinistryKey, r.Keywords, r.AssetUrl,
       r.RedirectUrl, r.HasMediaAssets, r.PublishOptions, r.[Timestamp],
       l.Location, l.Summary, l.SocialMediaHeadline, l.SocialMediaSummary
FROM dbo.NewsRelease r
LEFT JOIN dbo.Ministry m ON m.Id = r.MinistryId
LEFT JOIN dbo.NewsReleaseLanguage l ON l.ReleaseId = r.Id AND l.LanguageId = 4105
WHERE ${year(y)}`;

export const qDocuments = (y: number) => `-- name: documents:${y}
SELECT d.ReleaseId, d.Id AS DocumentId, d.SortIndex, dl.LanguageId, dl.PageTitle, dl.Headline, dl.Subheadline, dl.Byline, dl.BodyHtml
FROM dbo.NewsReleaseDocument d
JOIN dbo.NewsReleaseDocumentLanguage dl ON dl.DocumentId = d.Id
JOIN dbo.NewsRelease r ON r.Id = d.ReleaseId
WHERE ${year(y)}`;

export const qContacts = (y: number) => `-- name: contacts:${y}
SELECT c.DocumentId, c.LanguageId, c.SortIndex, c.Information
FROM dbo.NewsReleaseDocumentContact c
JOIN dbo.NewsReleaseDocument d ON d.Id = c.DocumentId
JOIN dbo.NewsRelease r ON r.Id = d.ReleaseId
WHERE ${year(y)}`;

export const qReleaseIndexes = (y: number) => `-- name: releaseIndexes:${y}
SELECT x.ReleaseId, 'ministries' AS IndexKind, m.[Key] AS IndexKey FROM dbo.NewsReleaseMinistry x JOIN dbo.Ministry m ON m.Id = x.MinistryId JOIN dbo.NewsRelease r ON r.Id = x.ReleaseId WHERE ${year(y)}
UNION ALL SELECT x.ReleaseId, 'sectors', s.[Key] FROM dbo.NewsReleaseSector x JOIN dbo.Sector s ON s.Id = x.SectorId JOIN dbo.NewsRelease r ON r.Id = x.ReleaseId WHERE ${year(y)}
UNION ALL SELECT x.ReleaseId, 'tags', t.[Key] FROM dbo.NewsReleaseTag x JOIN dbo.Tag t ON t.Id = x.TagId JOIN dbo.NewsRelease r ON r.Id = x.ReleaseId WHERE ${year(y)}
UNION ALL SELECT x.ReleaseId, 'themes', t.[Key] FROM dbo.NewsReleaseTheme x JOIN dbo.Theme t ON t.Id = x.ThemeId JOIN dbo.NewsRelease r ON r.Id = x.ReleaseId WHERE ${year(y)}`;

export const Q_RELEASE_KEYS_BY_ID = `-- name: releaseKeysById
SELECT r.Id, r.[Key] FROM dbo.NewsRelease r WHERE ${PUBLISHED}`;

export const Q_APP_SETTINGS = `-- name: appSettings
SELECT SettingName, SettingValue FROM dbo.ApplicationSetting WHERE SettingName IN ('HomeTopReleaseId', 'HomeFeatureReleaseId', 'granville')`;

export const Q_CATEGORY_FEATURES = `-- name: categoryFeatures
SELECT 'ministries' AS Kind, [Key], TopReleaseId, FeatureReleaseId FROM dbo.Ministry
UNION ALL SELECT 'sectors', [Key], TopReleaseId, FeatureReleaseId FROM dbo.Sector
UNION ALL SELECT 'themes', [Key], TopReleaseId, FeatureReleaseId FROM dbo.Theme`;

export const Q_CURRENT_SLIDES = `-- name: currentSlides
SELECT s.Id, cs.SortIndex, s.Headline, s.Summary, s.ActionUrl, s.Image, s.FacebookPostUrl, s.Justify, s.[Timestamp]
FROM dbo.CarouselSlide cs
JOIN dbo.Slide s ON s.Id = cs.SlideId
WHERE cs.CarouselId = (SELECT TOP 1 c.Id FROM dbo.Carousel c WHERE c.PublishDateTime <= SYSDATETIMEOFFSET() ORDER BY c.PublishDateTime DESC)
ORDER BY cs.SortIndex`;

export const Q_RESOURCE_LINKS = `-- name: resourceLinks
SELECT SortIndex, LinkText, LinkUrl FROM dbo.ResourceLink ORDER BY SortIndex`;

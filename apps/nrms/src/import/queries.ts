/**
 * Legacy SQL reads for the NRMS importer (spec §8). Year-batched in the same shape as
 * apps/news-api/src/import/queries.ts, but **without** its IsCommitted/IsPublished/IsActive
 * filters — NRMS imports every release, in every status (active, inactive, draft, …).
 *
 * A release with a null PublishDateTime *and* a null ReleaseDateTime has no year to group
 * under, so it (and only it) falls into year 0 — `COALESCE(YEAR(...), 0)` below.
 */

const RELEASE_YEAR = "COALESCE(YEAR(COALESCE(r.PublishDateTime, CAST(r.ReleaseDateTime AS DATETIMEOFFSET(7)))), 0)";
const yearFilter = (y: number) => `${RELEASE_YEAR} = ${Math.trunc(y)}`;

export const Q_RELEASE_YEARS = `-- name: releaseYears
SELECT DISTINCT ${RELEASE_YEAR} AS [Year] FROM dbo.NewsRelease r`;

/** All NewsRelease columns mapRelease() needs, with the lead ministry key joined in (see map.ts's LeadMinistryKey). */
export const releases = (y: number) => `-- name: releases:${y}
SELECT r.Id, r.[Key], r.ReleaseType, r.Reference, r.AtomId, r.Year, r.YearRelease, r.MinistryRelease, r.ActivityId,
       r.ReleaseDateTime, r.PublishDateTime, r.IsCommitted, r.IsPublished, r.PublishOptions, r.IsActive,
       r.HasMediaAssets, r.HasTranslations, r.NodSubscribers, r.MediaSubscribers, r.Keywords, r.AssetUrl, r.RedirectUrl,
       r.CollectionId, m.[Key] AS LeadMinistryKey
FROM dbo.NewsRelease r
LEFT JOIN dbo.Ministry m ON m.Id = r.MinistryId
WHERE ${yearFilter(y)}`;

export const releaseLanguages = (y: number) => `-- name: releaseLanguages:${y}
SELECT l.ReleaseId, l.LanguageId, l.Location, l.Summary, l.SocialMediaSummary
FROM dbo.NewsReleaseLanguage l
JOIN dbo.NewsRelease r ON r.Id = l.ReleaseId
WHERE ${yearFilter(y)}`;

export const documents = (y: number) => `-- name: documents:${y}
SELECT d.Id, d.ReleaseId, d.SortIndex, d.PageLayout
FROM dbo.NewsReleaseDocument d
JOIN dbo.NewsRelease r ON r.Id = d.ReleaseId
WHERE ${yearFilter(y)}`;

export const documentLanguages = (y: number) => `-- name: documentLanguages:${y}
SELECT dl.DocumentId, dl.LanguageId, dl.PageImageId, dl.PageTitle, dl.Organizations, dl.Headline, dl.Subheadline, dl.Byline, dl.BodyHtml
FROM dbo.NewsReleaseDocumentLanguage dl
JOIN dbo.NewsReleaseDocument d ON d.Id = dl.DocumentId
JOIN dbo.NewsRelease r ON r.Id = d.ReleaseId
WHERE ${yearFilter(y)}`;

export const documentContacts = (y: number) => `-- name: documentContacts:${y}
SELECT c.DocumentId, c.LanguageId, c.SortIndex, c.Information
FROM dbo.NewsReleaseDocumentContact c
JOIN dbo.NewsReleaseDocument d ON d.Id = c.DocumentId
JOIN dbo.NewsRelease r ON r.Id = d.ReleaseId
WHERE ${yearFilter(y)}`;

/** UNION ALL of the four category link tables, joined to each table's own `Key` column. Returns {ReleaseId, Kind, Key}. */
export const releaseCategories = (y: number) => `-- name: releaseCategories:${y}
SELECT x.ReleaseId, 'ministries' AS Kind, m.[Key] AS [Key] FROM dbo.NewsReleaseMinistry x JOIN dbo.Ministry m ON m.Id = x.MinistryId JOIN dbo.NewsRelease r ON r.Id = x.ReleaseId WHERE ${yearFilter(y)}
UNION ALL SELECT x.ReleaseId, 'sectors', s.[Key] FROM dbo.NewsReleaseSector x JOIN dbo.Sector s ON s.Id = x.SectorId JOIN dbo.NewsRelease r ON r.Id = x.ReleaseId WHERE ${yearFilter(y)}
UNION ALL SELECT x.ReleaseId, 'themes', t.[Key] FROM dbo.NewsReleaseTheme x JOIN dbo.Theme t ON t.Id = x.ThemeId JOIN dbo.NewsRelease r ON r.Id = x.ReleaseId WHERE ${yearFilter(y)}
UNION ALL SELECT x.ReleaseId, 'tags', g.[Key] FROM dbo.NewsReleaseTag x JOIN dbo.Tag g ON g.Id = x.TagId JOIN dbo.NewsRelease r ON r.Id = x.ReleaseId WHERE ${yearFilter(y)}`;

export const releaseMediaLists = (y: number) => `-- name: releaseMediaLists:${y}
SELECT x.ReleaseId, x.MediaDistributionListId
FROM dbo.NewsReleaseMediaDistribution x
JOIN dbo.NewsRelease r ON r.Id = x.ReleaseId
WHERE ${yearFilter(y)}`;

/** Joined to dbo.User for EmailAddress/DisplayName — legacy users become inactive Core users matched by email (spec §8). */
export const releaseLog = (y: number) => `-- name: releaseLog:${y}
SELECT l.Id, l.ReleaseId, l.[DateTime], l.UserId, l.Description, u.EmailAddress, u.DisplayName
FROM dbo.NewsReleaseLog l
JOIN dbo.NewsRelease r ON r.Id = l.ReleaseId
LEFT JOIN dbo.[User] u ON u.Id = l.UserId
WHERE ${yearFilter(y)}`;

/** Not imported (Q12 — legacy stores rendered blobs, not structured records); counted and reported only. */
export const Q_HISTORY_COUNT = `-- name: historyCount
SELECT ReleaseId, COUNT(*) AS Count FROM dbo.NewsReleaseHistory GROUP BY ReleaseId`;

/** Joined to Blob.Data for the image bytes. */
export const Q_PAGE_IMAGES = `-- name: pageImages
SELECT i.Id, i.SortOrder, i.Name, i.MimeType, b.Data AS Bytes
FROM dbo.NewsReleaseImage i
JOIN dbo.Blob b ON b.Id = i.BlobId`;

export const Q_PAGE_IMAGE_LANGUAGES = `-- name: pageImageLanguages
SELECT ImageId, LanguageId, AlternateName FROM dbo.NewsReleaseImageLanguage`;

export const Q_PAGE_TYPES = `-- name: pageTypes
SELECT PageTitle, LanguageId, ReleaseType, SortOrder, PageLayout, PageImageId FROM dbo.NewsReleaseType`;

export const Q_MEDIA_LISTS = `-- name: mediaLists
SELECT Id, [Key], DisplayName, SortOrder, IsActive FROM dbo.MediaDistributionList`;

/** NewsReleaseCollection has no NRMS table of its own — its Name feeds newestTerm() to resolve a release's government term. */
export const Q_COLLECTIONS = `-- name: collections
SELECT Id, Name FROM dbo.NewsReleaseCollection`;

/** Legacy dbo.User rows become inactive Core users matched by email (spec §8); entries with no user get the actor `system`. */
export const Q_USERS = `-- name: users
SELECT Id, DisplayName, EmailAddress, IsActive FROM dbo.[User]`;

export const Q_APP_SETTINGS = `-- name: appSettings
SELECT SettingName, SettingValue FROM dbo.ApplicationSetting`;

/** Ministry/Sector/Theme TopReleaseId/FeatureReleaseId (Tag has neither column). */
export const Q_CATEGORY_FEATURES = `-- name: categoryFeatures
SELECT 'ministries' AS Kind, [Key], TopReleaseId, FeatureReleaseId FROM dbo.Ministry
UNION ALL SELECT 'sectors', [Key], TopReleaseId, FeatureReleaseId FROM dbo.Sector
UNION ALL SELECT 'themes', [Key], TopReleaseId, FeatureReleaseId FROM dbo.Theme`;

export const Q_CAROUSELS = `-- name: carousels
SELECT Id, PublishDateTime, [Timestamp] FROM dbo.Carousel`;

/** Joined to Slide for its content. */
export const Q_CAROUSEL_SLIDES = `-- name: carouselSlides
SELECT cs.CarouselId, cs.SlideId, cs.SortIndex, s.Headline, s.Summary, s.ActionUrl, s.Image, s.FacebookPostUrl, s.Justify, s.[Timestamp]
FROM dbo.CarouselSlide cs
JOIN dbo.Slide s ON s.Id = cs.SlideId`;

export const Q_RESOURCE_LINKS = `-- name: resourceLinks
SELECT SortIndex, LinkText, LinkUrl FROM dbo.ResourceLink ORDER BY SortIndex`;

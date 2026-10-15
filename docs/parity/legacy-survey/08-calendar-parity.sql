/*
  08 — Corporate Calendar parity inputs (Phase 5). Run in Gcpe.Hub, read-only.

  PART A answers Q52 and helps size Q53. It returns counts only: no personal data, no free text.
         Results can go in results/Hub like the earlier surveys.

  PART B is the Q50 snapshot for the 5i side-by-side report check. It returns REAL activity
         content (titles, details, contacts). Do NOT put its results in the repo or in
         results/Hub. Save them somewhere private and tell Claude where.
         Run Part B as soon as possible after producing the legacy report PDFs, with @From/@To
         set to the same date range the PDFs cover, so both sides see the same data.

  HOW TO SAVE THE RESULTS (important):
    - In SQL Server Management Studio use Query > Results To > Results to File (or right-click a
      result grid > Save Results As > CSV). Do NOT copy results into Excel and save from there:
      Excel rewrites dates as "mm:ss.0" and the date part is lost.
    - Every Part B result starts with a "query" column (8.10, 8.11, …) so each section can be
      found even when all results land in one file. Dates and times come out as plain ISO text
      (yyyy-mm-ddThh:mm:ss), which no tool reformats.
    - Part C at the end lists how many rows each Part B query returned. Please include it.
*/
USE [Gcpe.Hub];   -- change if your Hub database is named differently
SET NOCOUNT ON;
SET TRANSACTION ISOLATION LEVEL READ UNCOMMITTED;

/* ===================== PART A — counts only (Q52, Q53) ===================== */

-- 8.1 Every category: how many activities use it, active vs deleted, and date span.
--     Q52: confirms which categories mark "awareness dates".
SELECT c.Id, c.Name, c.IsActive AS category_active,
       SUM(CASE WHEN a.IsActive = 1 THEN 1 ELSE 0 END) AS active_activities,
       SUM(CASE WHEN a.IsActive = 0 THEN 1 ELSE 0 END) AS deleted_activities,
       CONVERT(varchar(23), MIN(a.StartDateTime), 126) AS earliest, CONVERT(varchar(23), MAX(a.StartDateTime), 126) AS latest
FROM calendar.Category c
LEFT JOIN calendar.ActivityCategories ac ON ac.CategoryId = c.Id AND ac.IsActive = 1
LEFT JOIN calendar.Activity a ON a.Id = ac.ActivityId
GROUP BY c.Id, c.Name, c.IsActive
ORDER BY c.Name;

-- 8.2 Awareness-category activities (category 2) by year: how many would be imported regardless of age.
SELECT YEAR(a.StartDateTime) AS yr, a.IsActive, COUNT(*) AS activities
FROM calendar.Activity a
JOIN calendar.ActivityCategories ac ON ac.ActivityId = a.Id AND ac.IsActive = 1 AND ac.CategoryId = 2
GROUP BY YEAR(a.StartDateTime), a.IsActive
ORDER BY yr, a.IsActive;

-- 8.3 Activities ending in each upcoming month (sizes the post-cutoff import, Q53).
SELECT FORMAT(a.EndDateTime, 'yyyy-MM') AS end_month, a.IsActive, COUNT(*) AS activities
FROM calendar.Activity a
WHERE a.EndDateTime >= DATEADD(month, -1, GETDATE())
GROUP BY FORMAT(a.EndDateTime, 'yyyy-MM'), a.IsActive
ORDER BY end_month, a.IsActive;

/* ===================== PART B — snapshot (Q50). REAL CONTENT: keep out of the repo ===================== */

DECLARE @From datetime = '2026-06-01';   -- first day the legacy PDFs cover
DECLARE @To   datetime = '2026-09-01';   -- day AFTER the last day covered (exclusive): covers the
                                          -- June reports and the June–August 30-60-90 report

-- Activities overlapping the range (deleted ones included, so the comparison sees what the reports filter out).
IF OBJECT_ID('tempdb..#ids') IS NOT NULL DROP TABLE #ids;
SELECT a.Id INTO #ids
FROM calendar.Activity a
WHERE a.StartDateTime < @To AND (a.EndDateTime >= @From OR a.EndDateTime IS NULL);

-- 8.10 The activities themselves (TimeStamp/rowversion omitted).
SELECT '8.10' AS query, a.Id, CONVERT(varchar(23), a.StartDateTime, 126) AS StartDateTime, CONVERT(varchar(23), a.EndDateTime, 126) AS EndDateTime, a.PotentialDates, CONVERT(varchar(23), a.NRDateTime, 126) AS NRDateTime, a.IsAllDay, a.IsConfirmed,
       a.Title, a.Details, a.Schedule, a.Significance, a.Strategy, a.Comments, a.HqComments,
       a.LeadOrganization, a.Venue, a.Translations, a.OtherCity,
       a.StatusId, a.HqStatusId, a.HqSection, a.NRDistributionId, a.PremierRequestedId,
       a.ContactMinistryId, a.GovernmentRepresentativeId, a.CommunicationContactId, a.EventPlannerId,
       a.VideographerId, a.CityId,
       a.IsActive, a.IsIssue, a.IsAtLegislature, a.IsConfidential, a.IsCrossGovernment, a.IsMilestone,
       CONVERT(varchar(23), a.CreatedDateTime, 126) AS CreatedDateTime, a.CreatedBy, CONVERT(varchar(23), a.LastUpdatedDateTime, 126) AS LastUpdatedDateTime, a.LastUpdatedBy
FROM calendar.Activity a JOIN #ids i ON i.Id = a.Id
ORDER BY a.StartDateTime, a.Id;

-- 8.11–8.19 Their join rows.
SELECT '8.11' AS query, x.ActivityId, x.CategoryId, x.IsActive FROM calendar.ActivityCategories x JOIN #ids i ON i.Id = x.ActivityId;
SELECT '8.12' AS query, x.ActivityId, x.CommunicationMaterialId, x.IsActive FROM calendar.ActivityCommunicationMaterials x JOIN #ids i ON i.Id = x.ActivityId;
SELECT '8.13' AS query, x.ActivityId, x.InitiativeId, x.IsActive FROM calendar.ActivityInitiatives x JOIN #ids i ON i.Id = x.ActivityId;
SELECT '8.14' AS query, x.ActivityId, x.KeywordId, x.IsActive FROM calendar.ActivityKeywords x JOIN #ids i ON i.Id = x.ActivityId;
SELECT '8.15' AS query, x.ActivityId, x.NROriginId, x.IsActive FROM calendar.ActivityNROrigins x JOIN #ids i ON i.Id = x.ActivityId;
SELECT '8.16' AS query, x.ActivityId, x.SectorId, x.IsActive FROM calendar.ActivitySectors x JOIN #ids i ON i.Id = x.ActivityId;
SELECT '8.17' AS query, x.ActivityId, x.MinistryId, x.IsActive FROM calendar.ActivitySharedWith x JOIN #ids i ON i.Id = x.ActivityId;
SELECT '8.18' AS query, x.ActivityId, x.TagId, x.IsActive FROM calendar.ActivityTags x JOIN #ids i ON i.Id = x.ActivityId;
SELECT '8.19' AS query, x.ActivityId, x.ThemeId, x.IsActive FROM calendar.ActivityThemes x JOIN #ids i ON i.Id = x.ActivityId;

-- 8.20 Releases linked to those activities (the reports show them).
SELECT '8.20' AS query, r.Id, r.ActivityId, r.[Key], r.ReleaseType, CONVERT(varchar(33), r.PublishDateTime, 126) AS PublishDateTime, r.IsPublished, r.IsActive
FROM dbo.NewsRelease r JOIN #ids i ON i.Id = r.ActivityId;

-- 8.30–8.46 Lookups the reports display (whole tables; small).
SELECT '8.30' AS query, * FROM calendar.Category;
SELECT '8.31' AS query, * FROM calendar.City;
SELECT '8.32' AS query, * FROM calendar.CommunicationContact;
SELECT '8.33' AS query, * FROM calendar.CommunicationMaterial;
SELECT '8.34' AS query, * FROM calendar.EventPlanner;
SELECT '8.35' AS query, * FROM calendar.GovernmentRepresentative;
SELECT '8.36' AS query, * FROM calendar.Initiative;
SELECT '8.37' AS query, * FROM calendar.Keyword;
SELECT '8.38' AS query, * FROM calendar.NRDistribution;
SELECT '8.39' AS query, * FROM calendar.NROrigin;
SELECT '8.40' AS query, * FROM calendar.PremierRequested;
SELECT '8.41' AS query, * FROM calendar.Status;
SELECT '8.42' AS query, * FROM calendar.Videographer;
SELECT '8.43' AS query, Id, [Key], DisplayName, Abbreviation, IsActive FROM dbo.Ministry;
SELECT '8.44' AS query, Id, [Key], DisplayName, IsActive FROM dbo.Sector;
SELECT '8.45' AS query, Id, [Key], DisplayName, IsActive FROM dbo.Theme;
SELECT '8.46' AS query, Id, [Key], DisplayName, SortOrder, IsActive FROM dbo.Tag;   -- names for 8.18's tags

/* ===================== PART C — completeness check (counts only) ===================== */
-- How many rows each Part B query returned. A zero here is real; a missing section in the saved
-- file is an export problem.
SELECT '8.10' AS query, COUNT(*) AS rows_returned FROM #ids
UNION ALL SELECT '8.11', COUNT(*) FROM calendar.ActivityCategories x JOIN #ids i ON i.Id = x.ActivityId
UNION ALL SELECT '8.12', COUNT(*) FROM calendar.ActivityCommunicationMaterials x JOIN #ids i ON i.Id = x.ActivityId
UNION ALL SELECT '8.13', COUNT(*) FROM calendar.ActivityInitiatives x JOIN #ids i ON i.Id = x.ActivityId
UNION ALL SELECT '8.14', COUNT(*) FROM calendar.ActivityKeywords x JOIN #ids i ON i.Id = x.ActivityId
UNION ALL SELECT '8.15', COUNT(*) FROM calendar.ActivityNROrigins x JOIN #ids i ON i.Id = x.ActivityId
UNION ALL SELECT '8.16', COUNT(*) FROM calendar.ActivitySectors x JOIN #ids i ON i.Id = x.ActivityId
UNION ALL SELECT '8.17', COUNT(*) FROM calendar.ActivitySharedWith x JOIN #ids i ON i.Id = x.ActivityId
UNION ALL SELECT '8.18', COUNT(*) FROM calendar.ActivityTags x JOIN #ids i ON i.Id = x.ActivityId
UNION ALL SELECT '8.19', COUNT(*) FROM calendar.ActivityThemes x JOIN #ids i ON i.Id = x.ActivityId
UNION ALL SELECT '8.20', COUNT(*) FROM dbo.NewsRelease r JOIN #ids i ON i.Id = r.ActivityId
UNION ALL SELECT '8.46', COUNT(*) FROM dbo.Tag;

DROP TABLE #ids;

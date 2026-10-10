/*
  08 — Corporate Calendar parity inputs (Phase 5). Run in Gcpe.Hub, read-only.

  PART A answers Q52 and helps size Q53. It returns counts only: no personal data, no free text.
         Results can go in results/Hub like the earlier surveys.

  PART B is the Q50 snapshot for the 5i side-by-side report check. It returns REAL activity
         content (titles, details, contacts). Do NOT put its results in the repo or in
         results/Hub. Save them somewhere private and tell Claude where.
         Run Part B as soon as possible after producing the legacy report PDFs, with @From/@To
         set to the same date range the PDFs cover, so both sides see the same data.
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
       MIN(a.StartDateTime) AS earliest, MAX(a.StartDateTime) AS latest
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

DECLARE @From datetime = '2026-10-08';   -- set to the first day the legacy PDFs cover
DECLARE @To   datetime = '2027-01-08';   -- set to the last day the legacy PDFs cover (exclusive)

-- Activities overlapping the range (deleted ones included, so the comparison sees what the reports filter out).
IF OBJECT_ID('tempdb..#ids') IS NOT NULL DROP TABLE #ids;
SELECT a.Id INTO #ids
FROM calendar.Activity a
WHERE a.StartDateTime < @To AND (a.EndDateTime >= @From OR a.EndDateTime IS NULL);

-- 8.10 The activities themselves (TimeStamp/rowversion omitted).
SELECT a.Id, a.StartDateTime, a.EndDateTime, a.PotentialDates, a.NRDateTime, a.IsAllDay, a.IsConfirmed,
       a.Title, a.Details, a.Schedule, a.Significance, a.Strategy, a.Comments, a.HqComments,
       a.LeadOrganization, a.Venue, a.Translations, a.OtherCity,
       a.StatusId, a.HqStatusId, a.HqSection, a.NRDistributionId, a.PremierRequestedId,
       a.ContactMinistryId, a.GovernmentRepresentativeId, a.CommunicationContactId, a.EventPlannerId,
       a.VideographerId, a.CityId,
       a.IsActive, a.IsIssue, a.IsAtLegislature, a.IsConfidential, a.IsCrossGovernment, a.IsMilestone,
       a.CreatedDateTime, a.CreatedBy, a.LastUpdatedDateTime, a.LastUpdatedBy
FROM calendar.Activity a JOIN #ids i ON i.Id = a.Id
ORDER BY a.StartDateTime, a.Id;

-- 8.11–8.19 Their join rows.
SELECT x.ActivityId, x.CategoryId, x.IsActive FROM calendar.ActivityCategories x JOIN #ids i ON i.Id = x.ActivityId;
SELECT x.ActivityId, x.CommunicationMaterialId, x.IsActive FROM calendar.ActivityCommunicationMaterials x JOIN #ids i ON i.Id = x.ActivityId;
SELECT x.ActivityId, x.InitiativeId, x.IsActive FROM calendar.ActivityInitiatives x JOIN #ids i ON i.Id = x.ActivityId;
SELECT x.ActivityId, x.KeywordId, x.IsActive FROM calendar.ActivityKeywords x JOIN #ids i ON i.Id = x.ActivityId;
SELECT x.ActivityId, x.NROriginId, x.IsActive FROM calendar.ActivityNROrigins x JOIN #ids i ON i.Id = x.ActivityId;
SELECT x.ActivityId, x.SectorId, x.IsActive FROM calendar.ActivitySectors x JOIN #ids i ON i.Id = x.ActivityId;
SELECT x.ActivityId, x.MinistryId, x.IsActive FROM calendar.ActivitySharedWith x JOIN #ids i ON i.Id = x.ActivityId;
SELECT x.ActivityId, x.TagId, x.IsActive FROM calendar.ActivityTags x JOIN #ids i ON i.Id = x.ActivityId;
SELECT x.ActivityId, x.ThemeId, x.IsActive FROM calendar.ActivityThemes x JOIN #ids i ON i.Id = x.ActivityId;

-- 8.20 Releases linked to those activities (the reports show them).
SELECT r.Id, r.ActivityId, r.[Key], r.ReleaseType, r.PublishDateTime, r.IsPublished, r.IsActive
FROM dbo.NewsRelease r JOIN #ids i ON i.Id = r.ActivityId;

-- 8.30–8.44 Lookups the reports display (whole tables; small).
SELECT * FROM calendar.Category;
SELECT * FROM calendar.City;
SELECT * FROM calendar.CommunicationContact;
SELECT * FROM calendar.CommunicationMaterial;
SELECT * FROM calendar.EventPlanner;
SELECT * FROM calendar.GovernmentRepresentative;
SELECT * FROM calendar.Initiative;
SELECT * FROM calendar.Keyword;
SELECT * FROM calendar.NRDistribution;
SELECT * FROM calendar.NROrigin;
SELECT * FROM calendar.PremierRequested;
SELECT * FROM calendar.Status;
SELECT * FROM calendar.Videographer;
SELECT Id, [Key], DisplayName, Abbreviation, IsActive FROM dbo.Ministry;
SELECT Id, [Key], DisplayName, IsActive FROM dbo.Sector;
SELECT Id, [Key], DisplayName, IsActive FROM dbo.Theme;

DROP TABLE #ids;

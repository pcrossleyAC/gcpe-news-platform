/*
  04 — Hub Corporate Calendar (calendar.* schema). Run in Gcpe.Hub. Read-only; returns no personal
  data: people-lists (staff, contacts, representatives, planners, videographers) and free text
  (titles, details, comments, keywords) are counted or measured, never returned. See README.md.
  Feeds the Phase 5 Calendar parity spec and importer.
*/
USE [Gcpe.Hub];   -- change if your Hub database is named differently
SET NOCOUNT ON;
SET TRANSACTION ISOLATION LEVEL READ UNCOMMITTED;

-- 4.1 Activities per year of start date, by status and active flag.
SELECT YEAR(a.StartDateTime) AS yr, s.Name AS status, a.IsActive, COUNT(*) AS activities
FROM calendar.Activity a LEFT JOIN calendar.Status s ON s.Id = a.StatusId
GROUP BY YEAR(a.StartDateTime), s.Name, a.IsActive
ORDER BY yr, status, a.IsActive;

-- 4.2 Live workload at cutover: activities from 30 days ago onward.
SELECT s.Name AS status, a.IsActive, a.IsConfirmed, a.IsConfidential, COUNT(*) AS activities,
       MIN(a.StartDateTime) AS earliest, MAX(a.StartDateTime) AS latest
FROM calendar.Activity a LEFT JOIN calendar.Status s ON s.Id = a.StatusId
WHERE a.StartDateTime >= DATEADD(day, -30, GETDATE())
GROUP BY s.Name, a.IsActive, a.IsConfirmed, a.IsConfidential
ORDER BY activities DESC;

-- 4.3 HQ status and section use.
SELECT a.HqStatusId, hs.Name AS hq_status, a.HqSection, COUNT(*) AS activities
FROM calendar.Activity a LEFT JOIN calendar.Status hs ON hs.Id = a.HqStatusId
GROUP BY a.HqStatusId, hs.Name, a.HqSection ORDER BY activities DESC;

-- 4.4 How often every flag is set (all activities, and the last 2 years).
SELECT 'all' AS scope, COUNT(*) AS activities,
  SUM(CAST(IsConfirmed AS INT)) AS confirmed, SUM(CAST(IsIssue AS INT)) AS issue,
  SUM(CAST(IsAllDay AS INT)) AS all_day, SUM(CAST(IsAtLegislature AS INT)) AS at_legislature,
  SUM(CAST(IsConfidential AS INT)) AS confidential, SUM(CAST(IsCrossGovernment AS INT)) AS cross_government,
  SUM(CAST(IsMilestone AS INT)) AS milestone,
  SUM(CAST(IsTitleNeedsReview AS INT)) AS title_nr, SUM(CAST(IsDetailsNeedsReview AS INT)) AS details_nr,
  SUM(CAST(IsRepresentativeNeedsReview AS INT)) AS representative_nr, SUM(CAST(IsCityNeedsReview AS INT)) AS city_nr,
  SUM(CAST(IsStartDateNeedsReview AS INT)) AS start_nr, SUM(CAST(IsEndDateNeedsReview AS INT)) AS end_nr,
  SUM(CAST(IsCategoriesNeedsReview AS INT)) AS categories_nr, SUM(CAST(IsCommMaterialsNeedsReview AS INT)) AS comm_materials_nr,
  SUM(CAST(IsActiveNeedsReview AS INT)) AS active_nr, SUM(CAST(IsSignificanceNeedsReview AS INT)) AS significance_nr,
  SUM(CAST(IsStrategyNeedsReview AS INT)) AS strategy_nr, SUM(CAST(IsSchedulingConsiderationsNeedsReview AS INT)) AS scheduling_nr,
  SUM(CAST(IsInternalNotesNeedsReview AS INT)) AS internal_notes_nr, SUM(CAST(IsLeadOrganizationNeedsReview AS INT)) AS lead_org_nr,
  SUM(CAST(IsInitiativesNeedsReview AS INT)) AS initiatives_nr, SUM(CAST(IsTagsNeedsReview AS INT)) AS tags_nr,
  SUM(CAST(IsOriginNeedsReview AS INT)) AS origin_nr, SUM(CAST(IsDistributionNeedsReview AS INT)) AS distribution_nr,
  SUM(CAST(IsTranslationsRequiredNeedsReview AS INT)) AS translations_nr, SUM(CAST(IsPremierRequestedNeedsReview AS INT)) AS premier_nr,
  SUM(CAST(IsVenueNeedsReview AS INT)) AS venue_nr, SUM(CAST(IsEventPlannerNeedsReview AS INT)) AS event_planner_nr,
  SUM(CAST(IsDigitalNeedsReview AS INT)) AS digital_nr
FROM calendar.Activity
UNION ALL
SELECT 'last 2 years', COUNT(*),
  SUM(CAST(IsConfirmed AS INT)), SUM(CAST(IsIssue AS INT)), SUM(CAST(IsAllDay AS INT)), SUM(CAST(IsAtLegislature AS INT)),
  SUM(CAST(IsConfidential AS INT)), SUM(CAST(IsCrossGovernment AS INT)), SUM(CAST(IsMilestone AS INT)),
  SUM(CAST(IsTitleNeedsReview AS INT)), SUM(CAST(IsDetailsNeedsReview AS INT)), SUM(CAST(IsRepresentativeNeedsReview AS INT)),
  SUM(CAST(IsCityNeedsReview AS INT)), SUM(CAST(IsStartDateNeedsReview AS INT)), SUM(CAST(IsEndDateNeedsReview AS INT)),
  SUM(CAST(IsCategoriesNeedsReview AS INT)), SUM(CAST(IsCommMaterialsNeedsReview AS INT)), SUM(CAST(IsActiveNeedsReview AS INT)),
  SUM(CAST(IsSignificanceNeedsReview AS INT)), SUM(CAST(IsStrategyNeedsReview AS INT)), SUM(CAST(IsSchedulingConsiderationsNeedsReview AS INT)),
  SUM(CAST(IsInternalNotesNeedsReview AS INT)), SUM(CAST(IsLeadOrganizationNeedsReview AS INT)), SUM(CAST(IsInitiativesNeedsReview AS INT)),
  SUM(CAST(IsTagsNeedsReview AS INT)), SUM(CAST(IsOriginNeedsReview AS INT)), SUM(CAST(IsDistributionNeedsReview AS INT)),
  SUM(CAST(IsTranslationsRequiredNeedsReview AS INT)), SUM(CAST(IsPremierRequestedNeedsReview AS INT)), SUM(CAST(IsVenueNeedsReview AS INT)),
  SUM(CAST(IsEventPlannerNeedsReview AS INT)), SUM(CAST(IsDigitalNeedsReview AS INT))
FROM calendar.Activity WHERE StartDateTime >= DATEADD(year, -2, GETDATE());

-- 4.5 Which optional fields are filled, and how long the text fields get (vs their limits).
SELECT COUNT(*) AS activities,
  SUM(CASE WHEN EndDateTime IS NULL THEN 1 ELSE 0 END) AS no_end, SUM(CASE WHEN StartDateTime IS NULL THEN 1 ELSE 0 END) AS no_start,
  SUM(CASE WHEN EndDateTime < StartDateTime THEN 1 ELSE 0 END) AS end_before_start,
  SUM(CASE WHEN PotentialDates <> '' THEN 1 ELSE 0 END) AS with_potential_dates,
  SUM(CASE WHEN NRDateTime IS NOT NULL THEN 1 ELSE 0 END) AS with_nr_datetime,
  SUM(CASE WHEN ContactMinistryId IS NULL THEN 1 ELSE 0 END) AS no_contact_ministry,
  SUM(CASE WHEN GovernmentRepresentativeId IS NOT NULL THEN 1 ELSE 0 END) AS with_representative,
  SUM(CASE WHEN CommunicationContactId IS NOT NULL THEN 1 ELSE 0 END) AS with_comm_contact,
  SUM(CASE WHEN EventPlannerId IS NOT NULL THEN 1 ELSE 0 END) AS with_event_planner,
  SUM(CASE WHEN VideographerId IS NOT NULL THEN 1 ELSE 0 END) AS with_videographer,
  SUM(CASE WHEN CityId IS NOT NULL THEN 1 ELSE 0 END) AS with_city, SUM(CASE WHEN OtherCity <> '' THEN 1 ELSE 0 END) AS with_other_city,
  SUM(CASE WHEN NRDistributionId IS NOT NULL THEN 1 ELSE 0 END) AS with_nr_distribution,
  SUM(CASE WHEN PremierRequestedId IS NOT NULL THEN 1 ELSE 0 END) AS with_premier_requested,
  MAX(LEN(Title)) AS max_title, MAX(LEN(Details)) AS max_details, MAX(LEN(Schedule)) AS max_schedule,
  MAX(LEN(Significance)) AS max_significance, MAX(LEN(Strategy)) AS max_strategy, MAX(LEN(Comments)) AS max_comments,
  MAX(LEN(HqComments)) AS max_hq_comments, MAX(LEN(LeadOrganization)) AS max_lead_org, MAX(LEN(Venue)) AS max_venue,
  MAX(LEN(Translations)) AS max_translations, MAX(LEN(PotentialDates)) AS max_potential_dates
FROM calendar.Activity;

-- 4.6 Time-of-day patterns (all-day handling, midnight placeholders, time zone, Q19).
SELECT CAST(StartDateTime AS TIME(0)) AS start_time, IsAllDay, COUNT(*) AS activities
FROM calendar.Activity WHERE StartDateTime >= DATEADD(year, -2, GETDATE())
GROUP BY CAST(StartDateTime AS TIME(0)), IsAllDay HAVING COUNT(*) >= 20
ORDER BY activities DESC;

-- 4.7 Lookups (non-personal), in full.
SELECT * FROM calendar.Status;
SELECT * FROM calendar.Role;
SELECT * FROM calendar.Category;
SELECT * FROM calendar.CommunicationMaterial;
SELECT * FROM calendar.Initiative;
SELECT * FROM calendar.NROrigin;
SELECT * FROM calendar.NRDistribution;
SELECT * FROM calendar.PremierRequested;
SELECT * FROM calendar.City;

-- 4.8 People-lists and keywords: counts only.
SELECT 'GovernmentRepresentative' AS list, IsActive, COUNT(*) AS row_count FROM calendar.GovernmentRepresentative GROUP BY IsActive
UNION ALL SELECT 'CommunicationContact', IsActive, COUNT(*) FROM calendar.CommunicationContact GROUP BY IsActive
UNION ALL SELECT 'EventPlanner', IsActive, COUNT(*) FROM calendar.EventPlanner GROUP BY IsActive
UNION ALL SELECT 'Videographer', IsActive, COUNT(*) FROM calendar.Videographer GROUP BY IsActive
UNION ALL SELECT 'Keyword', IsActive, COUNT(*) FROM calendar.Keyword GROUP BY IsActive
ORDER BY list, IsActive;

-- 4.9 Multi-value fields: rows per activity (active links only).
SELECT 'categories' AS field, MAX(n) AS max_per_activity, AVG(n * 1.0) AS avg_per_activity, COUNT(*) AS activities_with_any FROM
  (SELECT ActivityId, COUNT(*) AS n FROM calendar.ActivityCategories WHERE IsActive = 1 GROUP BY ActivityId) x
UNION ALL SELECT 'communication materials', MAX(n), AVG(n * 1.0), COUNT(*) FROM
  (SELECT ActivityId, COUNT(*) AS n FROM calendar.ActivityCommunicationMaterials WHERE IsActive = 1 GROUP BY ActivityId) x
UNION ALL SELECT 'initiatives', MAX(n), AVG(n * 1.0), COUNT(*) FROM
  (SELECT ActivityId, COUNT(*) AS n FROM calendar.ActivityInitiatives WHERE IsActive = 1 GROUP BY ActivityId) x
UNION ALL SELECT 'keywords', MAX(n), AVG(n * 1.0), COUNT(*) FROM
  (SELECT ActivityId, COUNT(*) AS n FROM calendar.ActivityKeywords WHERE IsActive = 1 GROUP BY ActivityId) x
UNION ALL SELECT 'NR origins', MAX(n), AVG(n * 1.0), COUNT(*) FROM
  (SELECT ActivityId, COUNT(*) AS n FROM calendar.ActivityNROrigins WHERE IsActive = 1 GROUP BY ActivityId) x
UNION ALL SELECT 'sectors', MAX(n), AVG(n * 1.0), COUNT(*) FROM
  (SELECT ActivityId, COUNT(*) AS n FROM calendar.ActivitySectors WHERE IsActive = 1 GROUP BY ActivityId) x
UNION ALL SELECT 'shared with ministries', MAX(n), AVG(n * 1.0), COUNT(*) FROM
  (SELECT ActivityId, COUNT(*) AS n FROM calendar.ActivitySharedWith WHERE IsActive = 1 GROUP BY ActivityId) x
UNION ALL SELECT 'tags', MAX(n), AVG(n * 1.0), COUNT(*) FROM
  (SELECT ActivityId, COUNT(*) AS n FROM calendar.ActivityTags WHERE IsActive = 1 GROUP BY ActivityId) x
UNION ALL SELECT 'themes', MAX(n), AVG(n * 1.0), COUNT(*) FROM
  (SELECT ActivityId, COUNT(*) AS n FROM calendar.ActivityThemes WHERE IsActive = 1 GROUP BY ActivityId) x;

-- 4.10 Category and communication-material usage (which lookups are alive).
SELECT c.Name AS category, c.IsActive, COUNT(ac.Id) AS activities
FROM calendar.Category c LEFT JOIN calendar.ActivityCategories ac ON ac.CategoryId = c.Id AND ac.IsActive = 1
GROUP BY c.Name, c.IsActive ORDER BY activities DESC;
SELECT m.Name AS communication_material, m.IsActive, COUNT(am.Id) AS activities
FROM calendar.CommunicationMaterial m LEFT JOIN calendar.ActivityCommunicationMaterials am ON am.CommunicationMaterialId = m.Id AND am.IsActive = 1
GROUP BY m.Name, m.IsActive ORDER BY activities DESC;

-- 4.11 Activities per contact ministry, last 2 years (ministry names only).
SELECT m.[Key] AS ministry, COUNT(*) AS activities
FROM calendar.Activity a LEFT JOIN dbo.Ministry m ON m.Id = a.ContactMinistryId
WHERE a.StartDateTime >= DATEADD(year, -2, GETDATE())
GROUP BY m.[Key] ORDER BY activities DESC;

-- 4.12 Attached files: counts, types, sizes (names and contents are not returned).
SELECT FileType, COUNT(*) AS files, CAST(SUM(CAST(FileLength AS BIGINT)) / 1048576.0 AS DECIMAL(12,1)) AS mb,
       MAX(FileLength) AS largest_bytes
FROM calendar.ActivityFiles GROUP BY FileType ORDER BY files DESC;

-- 4.13 Calendar users: counts by role, active, and ministries per user (no names).
SELECT r.Name AS role, u.IsActive, COUNT(*) AS users,
       SUM(CASE WHEN u.HiddenColumns <> '' THEN 1 ELSE 0 END) AS with_hidden_columns
FROM calendar.SystemUser u LEFT JOIN calendar.Role r ON r.Id = u.RoleId
GROUP BY r.Name, u.IsActive ORDER BY role, u.IsActive;
SELECT ministries_per_user, COUNT(*) AS users FROM
  (SELECT u.Id, COUNT(um.Id) AS ministries_per_user FROM calendar.SystemUser u
     LEFT JOIN calendar.SystemUserMinistry um ON um.SystemUserId = u.Id AND um.IsActive = 1
    WHERE u.IsActive = 1 GROUP BY u.Id) x
GROUP BY ministries_per_user ORDER BY ministries_per_user;
SELECT FilterDisplayValue, COUNT(*) AS users FROM calendar.SystemUser WHERE IsActive = 1 GROUP BY FilterDisplayValue;

-- 4.14 Saved filters and favourites: counts, and which filter fields people use.
SELECT COUNT(*) AS saved_filters, SUM(CAST(IsActive AS INT)) AS active, MAX(LEN(QueryString)) AS longest_query
FROM calendar.ActivityFilter;
-- Returns parameter NAMES only, not values. (XML split, so it runs on any SQL Server version.)
SELECT LEFT(p.part, CHARINDEX('=', p.part + '=') - 1) AS filter_parameter, COUNT(*) AS uses
FROM calendar.ActivityFilter f
CROSS APPLY (SELECT CAST('<x>' + REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(f.QueryString, '?', ''), '&', '&amp;'), '<', '&lt;'), '>', '&gt;'), '&amp;', '</x><x>') + '</x>' AS XML) AS doc) d
CROSS APPLY (SELECT n.c.value('.', 'NVARCHAR(400)') AS part FROM d.doc.nodes('/x') n(c)) p
WHERE f.IsActive = 1 AND p.part <> ''
GROUP BY LEFT(p.part, CHARINDEX('=', p.part + '=') - 1) ORDER BY uses DESC;
SELECT COUNT(*) AS favourites, COUNT(DISTINCT SystemUserId) AS users_with_favourites FROM calendar.FavoriteActivity;

-- 4.15 Change log: volume and what gets logged (no values returned).
SELECT YEAR(CreatedDateTime) AS yr, LogType, Operation, COUNT(*) AS entries
FROM calendar.Log GROUP BY YEAR(CreatedDateTime), LogType, Operation ORDER BY yr, entries DESC;
SELECT TableName, LEFT(FieldName, 60) AS field_name, COUNT(*) AS entries
FROM calendar.Log GROUP BY TableName, LEFT(FieldName, 60) HAVING COUNT(*) >= 20 ORDER BY entries DESC;

-- 4.16 News feed entries (calendar.NewsFeed): volume only.
SELECT YEAR(CreatedDateTime) AS yr, IsActive, COUNT(*) AS entries FROM calendar.NewsFeed
GROUP BY YEAR(CreatedDateTime), IsActive ORDER BY yr;

-- 4.17 Releases linked to activities, by activity status (Forecast, NRMS ↔ Calendar link).
SELECT s.Name AS activity_status, COUNT(r.Id) AS linked_releases, COUNT(DISTINCT a.Id) AS activities
FROM calendar.Activity a
JOIN dbo.NewsRelease r ON r.ActivityId = a.Id
LEFT JOIN calendar.Status s ON s.Id = a.StatusId
GROUP BY s.Name ORDER BY linked_releases DESC;

-- 4.18 Orphans and integrity.
SELECT 'link to missing activity' AS problem, COUNT(*) AS n FROM calendar.ActivityCategories x
  WHERE NOT EXISTS (SELECT 1 FROM calendar.Activity a WHERE a.Id = x.ActivityId)
UNION ALL SELECT 'activity with missing status', COUNT(*) FROM calendar.Activity a
  WHERE a.StatusId IS NOT NULL AND NOT EXISTS (SELECT 1 FROM calendar.Status s WHERE s.Id = a.StatusId)
UNION ALL SELECT 'activity with missing city', COUNT(*) FROM calendar.Activity a
  WHERE a.CityId IS NOT NULL AND NOT EXISTS (SELECT 1 FROM calendar.City c WHERE c.Id = a.CityId)
UNION ALL SELECT 'activity with missing contact ministry', COUNT(*) FROM calendar.Activity a
  WHERE a.ContactMinistryId IS NOT NULL AND NOT EXISTS (SELECT 1 FROM dbo.Ministry m WHERE m.Id = a.ContactMinistryId)
UNION ALL SELECT 'activity created by unknown user', COUNT(*) FROM calendar.Activity a
  WHERE a.CreatedBy IS NOT NULL AND NOT EXISTS (SELECT 1 FROM calendar.SystemUser u WHERE u.Id = a.CreatedBy);

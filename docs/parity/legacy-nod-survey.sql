/*
  Legacy NoD / NewsDistribution / Hub survey for Phase 4
  (spec: docs/superpowers/specs/2026-10-05-nod-distribution-parity-design.md).

  Answers open questions Q21 (subscriber counts and send sizes) and Q24 (email templates), and
  checks the live schema against the .sqlproj definitions the Phase 4 importer is built from.

  SAFE TO RUN ON PRODUCTION:
    - SELECT only. No writes, no temp tables, no procedures.
    - READ UNCOMMITTED, so it takes no shared locks. The counts may be off by in-flight rows,
      which is fine for sizing.
    - No email addresses or other personal data are returned. Everything is a count, except:
      list/category names, SysConfig rows, Site templates and media list names. Domains of
      subscriber emails are only returned when 25 or more subscribers share one, so no
      individual is identifiable.
    - Before sending the results, glance over the SysConfig output (parts 1.9 and 2.6) in case
      a value holds anything secret.

  HOW TO RUN: set the three database names below to the real ones, then run each part
  (SSMS: "Results to Text" or save each grid as CSV). Each part starts with its own USE.
  Return all result sets. Note any query that errors, with its message, rather than editing it.
*/

SET NOCOUNT ON;
SET TRANSACTION ISOLATION LEVEL READ UNCOMMITTED;

/* =============================================================================================
   PART 0 — the server
   ============================================================================================= */
SELECT @@VERSION AS sql_server_version, SERVERPROPERTY('Collation') AS server_collation,
       SYSDATETIMEOFFSET() AS run_at;

/* =============================================================================================
   PART 1 — NewsOnDemand database          <<< change the name if different
   ============================================================================================= */
USE [Gcpe.NewsOnDemand];

-- 1.1 Live schema: every column of every table (compare with the .sqlproj).
SELECT t.name AS table_name, c.column_id, c.name AS column_name, ty.name AS data_type,
       c.max_length, c.is_nullable, DB_NAME() AS db
FROM sys.tables t
JOIN sys.columns c ON c.object_id = t.object_id
JOIN sys.types ty ON ty.user_type_id = c.user_type_id
ORDER BY t.name, c.column_id;

-- 1.2 Row counts and size per table.
SELECT t.name AS table_name, SUM(p.rows) AS row_count,
       CAST(SUM(a.total_pages) * 8 / 1024.0 AS DECIMAL(12,1)) AS size_mb
FROM sys.tables t
JOIN sys.partitions p ON p.object_id = t.object_id AND p.index_id IN (0, 1)
JOIN sys.allocation_units a ON a.container_id = p.partition_id
GROUP BY t.name
ORDER BY row_count DESC;

-- 1.3 Subscribers by state and delivery preference (Q21).
SELECT IsEnabled, IsDeleted, IsSelfSubscription, ImmediateDelivery, DigestDelivery,
       COUNT(*) AS subscribers
FROM dbo.Subscriber
GROUP BY IsEnabled, IsDeleted, IsSelfSubscription, ImmediateDelivery, DigestDelivery
ORDER BY subscribers DESC;

-- 1.4 Registrations per year, and how many of each year are still active.
SELECT YEAR(RegisteredDateTime) AS registered_year, COUNT(*) AS registered,
       SUM(CASE WHEN IsEnabled = 1 AND IsDeleted = 0 THEN 1 ELSE 0 END) AS still_active
FROM dbo.Subscriber
GROUP BY YEAR(RegisteredDateTime)
ORDER BY registered_year;

-- 1.5 Categories and lists, with active subscriber counts (names only, no people).
SELECT lc.[Key] AS category_key, lc.CategoryName, lc.IsEnabled AS category_enabled,
       lc.IsDeleted AS category_deleted, s.SiteName, l.[Key] AS list_key, l.ListName,
       l.SlotNumber, l.IsDeleted AS list_deleted, l.TopicUrl,
       (SELECT COUNT(*) FROM dbo.SubscriberList sl
          JOIN dbo.Subscriber sb ON sb.SubscriberGuid = sl.SubscriberGuid
         WHERE sl.ListGuid = l.ListGuid AND sb.IsEnabled = 1 AND sb.IsDeleted = 0) AS active_subscribers,
       (SELECT COUNT(*) FROM dbo.ListFeed lf WHERE lf.ListGuid = l.ListGuid) AS feeds
FROM dbo.List l
JOIN dbo.ListCategory lc ON lc.CategoryGuid = l.CategoryGuid
JOIN dbo.Site s ON s.Guid = l.SiteGuid
ORDER BY lc.[Key], l.SlotNumber, l.ListName;

-- 1.6 Lists per active subscriber (how many lists people pick), as a distribution.
SELECT lists_per_subscriber, COUNT(*) AS subscribers
FROM (SELECT sb.SubscriberGuid, COUNT(sl.ListGuid) AS lists_per_subscriber
        FROM dbo.Subscriber sb
        LEFT JOIN dbo.SubscriberList sl ON sl.SubscriberGuid = sb.SubscriberGuid
       WHERE sb.IsEnabled = 1 AND sb.IsDeleted = 0
       GROUP BY sb.SubscriberGuid) x
GROUP BY lists_per_subscriber
ORDER BY lists_per_subscriber;

-- 1.7 Send sizes over the last 365 days: recipients per article (Q21), plus bounces.
--     The 20 largest, then the overall distribution.
SELECT TOP 20 a.ArticleSourceID, a.PublishDateTimeUtc,
       SUM(CAST(sa.ImmediateAttempted AS INT)) AS immediate_attempted,
       SUM(CAST(sa.ImmediateDelivered AS INT)) AS immediate_delivered,
       SUM(CAST(sa.DigestAttempted AS INT))    AS digest_attempted,
       SUM(CAST(sa.DigestDelivered AS INT))    AS digest_delivered,
       SUM(CAST(sa.HardBounced AS INT))        AS hard_bounced
FROM dbo.Article a
JOIN dbo.SubscriberArticle sa ON sa.ArticleGuid = a.ArticleGuid
WHERE a.PublishDateTimeUtc >= DATEADD(day, -365, SYSDATETIMEOFFSET())
GROUP BY a.ArticleSourceID, a.PublishDateTimeUtc
ORDER BY immediate_attempted + digest_attempted DESC;

SELECT COUNT(*) AS articles_365d,
       AVG(recipients * 1.0) AS avg_recipients,
       MAX(recipients) AS max_recipients,
       SUM(bounced) AS hard_bounced_total
FROM (SELECT a.ArticleGuid, COUNT(*) AS recipients, SUM(CAST(sa.HardBounced AS INT)) AS bounced
        FROM dbo.Article a
        JOIN dbo.SubscriberArticle sa ON sa.ArticleGuid = a.ArticleGuid
       WHERE a.PublishDateTimeUtc >= DATEADD(day, -365, SYSDATETIMEOFFSET())
       GROUP BY a.ArticleGuid) x;

-- 1.8 Articles per day (last 90 days) — how many items a digest typically groups.
SELECT CAST(a.PublishDateTimeUtc AS DATE) AS day, COUNT(*) AS articles,
       SUM(CAST(a.IsImmediateDelivered AS INT)) AS immediate_done,
       SUM(CAST(a.IsDigestDelivered AS INT)) AS digest_done
FROM dbo.Article a
WHERE a.PublishDateTimeUtc >= DATEADD(day, -90, SYSDATETIMEOFFSET())
GROUP BY CAST(a.PublishDateTimeUtc AS DATE)
ORDER BY day;

-- 1.9 SysConfig (flags, last digest run, etc.). Review for secrets before sending.
SELECT ConfigKey, ConfigValue, ConfigDataType, ConfigDescription FROM dbo.SysConfig ORDER BY ConfigKey;

-- 1.10 Sites and their email templates (Q24). Templates are site layout, not personal data.
SELECT Guid, SiteName, SiteDescription, AbsoluteUri, ReplyToEmail, BannerSource,
       LEN(HtmlTemplate) AS html_template_length, LEN(HtmlItemTemplate) AS item_template_length
FROM dbo.Site;
SELECT SiteName, HtmlTemplate, HtmlItemTemplate FROM dbo.Site;   -- save this result as-is
SELECT Name, TemplateType, FilePath FROM dbo.Template;            -- believed unused; confirm

-- 1.11 Pending and used links (signups that never verified live only here).
SELECT CASE WHEN SubscribeDate IS NOT NULL THEN 'used'
            WHEN ExpiryDate < GETDATE() THEN 'expired, never used'
            ELSE 'pending' END AS link_state,
       CASE WHEN SubscriberGuid IS NULL THEN 'no subscriber yet' ELSE 'existing subscriber' END AS kind,
       COUNT(*) AS links, MIN(ExpiryDate) AS oldest_expiry, MAX(ExpiryDate) AS newest_expiry
FROM dbo.SubscriberLink
GROUP BY CASE WHEN SubscribeDate IS NOT NULL THEN 'used'
              WHEN ExpiryDate < GETDATE() THEN 'expired, never used'
              ELSE 'pending' END,
         CASE WHEN SubscriberGuid IS NULL THEN 'no subscriber yet' ELSE 'existing subscriber' END;

-- 1.12 Audit log: actions per year (feeds reports and the purge rules; Q25).
SELECT YEAR(EventDate) AS yr, [Action], EntityType, COUNT(*) AS events
FROM dbo.SysLog
GROUP BY YEAR(EventDate), [Action], EntityType
ORDER BY yr, events DESC;

-- 1.13 What the 90-day purge rule WOULD remove today, if it ran (Q25). Counts only.
SELECT
  (SELECT COUNT(*) FROM dbo.Subscriber
    WHERE IsEnabled = 0 AND RegisteredDateTime <= DATEADD(day, -10, GETDATE())) AS disabled_10d_plus,
  (SELECT COUNT(DISTINCT EntityGuid) FROM dbo.SysLog
    WHERE [Action] IN ('Unsubscribe', 'DeleteSubscriber', 'ChangeEmail')
      AND EventDate <= DATEADD(day, -90, GETDATE())) AS ended_90d_plus_any_age;

-- 1.14 Email domains with 25+ active subscribers (for the internal-domain priority bump).
SELECT LOWER(SUBSTRING(EmailAddress, CHARINDEX('@', EmailAddress) + 1, 150)) AS domain,
       COUNT(*) AS active_subscribers
FROM dbo.Subscriber
WHERE IsEnabled = 1 AND IsDeleted = 0 AND CHARINDEX('@', EmailAddress) > 0
GROUP BY LOWER(SUBSTRING(EmailAddress, CHARINDEX('@', EmailAddress) + 1, 150))
HAVING COUNT(*) >= 25
ORDER BY active_subscribers DESC;

/* =============================================================================================
   PART 2 — NewsDistribution database      <<< change the name if different
   ============================================================================================= */
USE [Gcpe.NewsDistribution];

-- 2.1 Live schema.
SELECT t.name AS table_name, c.column_id, c.name AS column_name, ty.name AS data_type,
       c.max_length, c.is_nullable, DB_NAME() AS db
FROM sys.tables t
JOIN sys.columns c ON c.object_id = t.object_id
JOIN sys.types ty ON ty.user_type_id = c.user_type_id
ORDER BY t.name, c.column_id;

-- 2.2 Row counts and size per table.
SELECT t.name AS table_name, SUM(p.rows) AS row_count,
       CAST(SUM(a.total_pages) * 8 / 1024.0 AS DECIMAL(12,1)) AS size_mb
FROM sys.tables t
JOIN sys.partitions p ON p.object_id = t.object_id AND p.index_id IN (0, 1)
JOIN sys.allocation_units a ON a.container_id = p.partition_id
GROUP BY t.name
ORDER BY row_count DESC;

-- 2.3 Queue state by priority (anything stuck shows as attempted but not delivered).
SELECT Priority, IsAttempted, IsDelivered, COUNT(*) AS messages,
       MIN(DeliveryDate) AS oldest, MAX(DeliveryDate) AS newest
FROM dbo.MessageQueue
GROUP BY Priority, IsAttempted, IsDelivered
ORDER BY Priority DESC, IsAttempted, IsDelivered;

-- 2.4 Volume per day and the busiest hours, last 90 days (Q21/Q22). DeliveryDate defaults to
--     the time the row was queued.
SELECT CAST(DeliveryDate AS DATE) AS day, COUNT(*) AS queued,
       SUM(CAST(IsDelivered AS INT)) AS delivered
FROM dbo.MessageQueue
WHERE DeliveryDate >= DATEADD(day, -90, SYSDATETIMEOFFSET())
GROUP BY CAST(DeliveryDate AS DATE)
ORDER BY day;

SELECT TOP 20 DATEADD(hour, DATEDIFF(hour, 0, CAST(DeliveryDate AS DATETIME)), 0) AS hour_start,
       COUNT(*) AS queued
FROM dbo.MessageQueue
WHERE DeliveryDate >= DATEADD(day, -365, SYSDATETIMEOFFSET())
GROUP BY DATEADD(hour, DATEDIFF(hour, 0, CAST(DeliveryDate AS DATETIME)), 0)
ORDER BY queued DESC;

-- 2.5 Which applications send, and how much (ApplicationId values to be mapped).
SELECT mc.ApplicationId, mc.IsHTMLContent, COUNT(DISTINCT mc.MessageGuid) AS messages,
       COUNT(mq.RecipientGuid) AS recipients
FROM dbo.MessageContent mc
LEFT JOIN dbo.MessageQueue mq ON mq.MessageGuid = mc.MessageGuid
GROUP BY mc.ApplicationId, mc.IsHTMLContent
ORDER BY recipients DESC;

-- 2.6 SysConfig. Review for secrets before sending.
SELECT ConfigKey, ConfigValue, ConfigDataType, ConfigDescription FROM dbo.SysConfig ORDER BY ConfigKey;

-- 2.7 Audit log actions per year (errors and pauses show up here).
SELECT YEAR(EventDate) AS yr, [Action], EntityType, COUNT(*) AS events
FROM dbo.SysLog
GROUP BY YEAR(EventDate), [Action], EntityType
ORDER BY yr, events DESC;

/* =============================================================================================
   PART 3 — Hub database                   <<< change the name if different
   ============================================================================================= */
USE [Gcpe.Hub];

-- 3.1 Media distribution lists and how often each was used, last 2 years.
SELECT m.[Key], m.DisplayName, m.SortOrder, m.IsActive,
       (SELECT COUNT(*) FROM dbo.NewsReleaseMediaDistribution d
          JOIN dbo.NewsRelease r ON r.Id = d.ReleaseId
         WHERE d.MediaDistributionListId = m.Id
           AND r.PublishDateTime >= DATEADD(year, -2, SYSDATETIMEOFFSET())) AS releases_2y
FROM dbo.MediaDistributionList m
ORDER BY m.SortOrder, m.DisplayName;

-- 3.2 Audience sizes the Hub recorded at publish time (Q21): the biggest sends, and per month.
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

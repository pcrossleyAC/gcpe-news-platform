/*
  06 — News On Demand. Run in Gcpe.NewsOnDemand. Read-only; returns no personal data (no email
  addresses; domains only when 25+ subscribers share one). See README.md.
  Feeds Phase 4: Q21 (counts and send sizes), Q24 (email templates), Q25 (retention).
  Schema and row counts come from 01-catalog.sql.
*/
USE [Gcpe.NewsOnDemand];   -- change if your NoD database is named differently
SET NOCOUNT ON;
SET TRANSACTION ISOLATION LEVEL READ UNCOMMITTED;


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

-- 1.9 SysConfig: flags, last digest run, etc. (secret-looking values masked).
SELECT ConfigKey,
       CASE WHEN ConfigKey LIKE '%pass%' OR ConfigKey LIKE '%pwd%' OR ConfigKey LIKE '%secret%' OR ConfigKey LIKE '%key%'
              OR ConfigKey LIKE '%token%' OR ConfigKey LIKE '%connection%' OR ConfigKey LIKE '%credential%'
            THEN '***' ELSE ConfigValue END AS ConfigValue,
       ConfigDataType, ConfigDescription
FROM dbo.SysConfig ORDER BY ConfigKey;

-- 1.10 Sites and their email templates (Q24). Templates are site layout, not personal data.
SELECT Guid, SiteName, SiteDescription, AbsoluteUri, ReplyToEmail, BannerSource,
       LEN(HtmlTemplate) AS html_template_length, LEN(HtmlItemTemplate) AS item_template_length
FROM dbo.Site;
-- 1.10b Save this result exactly as returned (Q24).
SELECT SiteName, HtmlTemplate, HtmlItemTemplate FROM dbo.Site;
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


/*
  07 — News Distribution. Run in Gcpe.NewsDistribution. Read-only; returns no personal data.
  See README.md. Feeds Phase 4: Q21/Q22 (volumes, peaks, senders).
  Schema and row counts come from 01-catalog.sql.
*/
USE [Gcpe.NewsDistribution];   -- change if your Distribution database is named differently
SET NOCOUNT ON;
SET TRANSACTION ISOLATION LEVEL READ UNCOMMITTED;


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

-- 2.6 SysConfig (secret-looking values masked).
SELECT ConfigKey,
       CASE WHEN ConfigKey LIKE '%pass%' OR ConfigKey LIKE '%pwd%' OR ConfigKey LIKE '%secret%' OR ConfigKey LIKE '%key%'
              OR ConfigKey LIKE '%token%' OR ConfigKey LIKE '%connection%' OR ConfigKey LIKE '%credential%'
            THEN '***' ELSE ConfigValue END AS ConfigValue,
       ConfigDataType, ConfigDescription
FROM dbo.SysConfig ORDER BY ConfigKey;

-- 2.7 Audit log actions per year (errors and pauses show up here).
SELECT YEAR(EventDate) AS yr, [Action], EntityType, COUNT(*) AS events
FROM dbo.SysLog
GROUP BY YEAR(EventDate), [Action], EntityType
ORDER BY yr, events DESC;


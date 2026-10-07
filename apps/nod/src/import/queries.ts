/**
 * Read-only queries against legacy Gcpe.NewsOnDemand. Each starts with `-- name: <name>`, which
 * keys the fake source in tests. None reads SysLog.EntityData/EventData or
 * SubscriberLink.SubscriberInfo, which hold addresses. Only the subscribers query reads one,
 * the subscriber's own.
 */

export const Q_LISTS = `-- name: lists
SELECT l.ListGuid, l.[Key] AS ListKey, l.ListName, l.IsDeleted AS ListDeleted,
       c.[Key] AS CategoryKey, c.IsDeleted AS CategoryDeleted
  FROM dbo.List l JOIN dbo.ListCategory c ON c.CategoryGuid = l.CategoryGuid`;

export const Q_SUBSCRIBERS = `-- name: subscribers
SELECT SubscriberGuid, RegisteredDateTime, EmailAddress, IsSelfSubscription, IsEnabled, IsDeleted,
       ImmediateDelivery, DigestDelivery
  FROM dbo.Subscriber`;

export const Q_SUBSCRIBER_LISTS = `-- name: subscriberLists
SELECT SubscriberGuid, ListGuid FROM dbo.SubscriberList`;

/** When each subscriber last unsubscribed (104) or was deleted (8); EntityType 1 = Subscriber. */
export const Q_ENDED = `-- name: ended
SELECT EntityGuid AS SubscriberGuid, MAX(EventDate) AS EndedAt
  FROM dbo.SysLog
 WHERE Action IN ('104', '8') AND EntityType = '1' AND EntityGuid IS NOT NULL
 GROUP BY EntityGuid`;

/** Each subscriber's latest removal from each media list (106 UnsubscribedFromList; EventGuid is the list). */
export const Q_MEDIA_LIST_LEAVES = `-- name: mediaListLeaves
SELECT s.EntityGuid AS SubscriberGuid, s.EventGuid AS ListGuid, MAX(s.EventDate) AS LeftAt
  FROM dbo.SysLog s
  JOIN dbo.List l ON l.ListGuid = s.EventGuid
  JOIN dbo.ListCategory c ON c.CategoryGuid = l.CategoryGuid
 WHERE s.Action = '106' AND s.EntityType = '1' AND c.[Key] = 'media-distribution-lists'
 GROUP BY s.EntityGuid, s.EventGuid`;

/** Signups still waiting for their verification link: counted only, never imported. */
export const Q_UNCONFIRMED_SIGNUPS = `-- name: unconfirmedSignups
SELECT COUNT(*) AS Signups FROM dbo.SubscriberLink
 WHERE SubscriberGuid IS NULL AND SubscribeDate IS NULL AND ExpiryDate > GETDATE()`;

export const Q_DIGEST_END = `-- name: digestEnd
SELECT ConfigValue FROM dbo.SysConfig WHERE ConfigKey = 'DailyDigestEndDateTimeUtc'`;

export const ALL_QUERIES = [Q_LISTS, Q_SUBSCRIBERS, Q_SUBSCRIBER_LISTS, Q_ENDED, Q_MEDIA_LIST_LEAVES, Q_UNCONFIRMED_SIGNUPS, Q_DIGEST_END];

export const MAX_SINCE_DAYS = 92;

function checkDays(sinceDays: number): number {
  if (!Number.isInteger(sinceDays) || sinceDays < 1 || sinceDays > MAX_SINCE_DAYS) throw new RangeError(`--since-days must be a whole number from 1 to ${MAX_SINCE_DAYS}`);
  return sinceDays;
}

export function qArticles(sinceDays: number): string {
  return `-- name: articles
SELECT a.ArticleGuid, a.ArticleSourceID, a.RelativeUri, a.PublishDateTimeUtc, a.IsDeleted,
       (SELECT TOP 1 c.TitleText FROM dbo.ArticleContent c WHERE c.ArticleGuid = a.ArticleGuid
         ORDER BY c.UpdateDateTimeUtc DESC) AS Title
  FROM dbo.Article a
 WHERE a.PublishDateTimeUtc >= DATEADD(day, -${checkDays(sinceDays)}, SYSDATETIMEOFFSET())`;
}

export function qArticleLists(sinceDays: number): string {
  return `-- name: articleLists
SELECT al.ArticleGuid, al.ListGuid
  FROM dbo.ArticleList al JOIN dbo.Article a ON a.ArticleGuid = al.ArticleGuid
 WHERE a.PublishDateTimeUtc >= DATEADD(day, -${checkDays(sinceDays)}, SYSDATETIMEOFFSET())`;
}

const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** One article's recipients. Per article, so at most ~12,600 rows (Q21's largest send) are held at once. */
export function qSubscriberArticles(articleGuid: string): string {
  const guid = articleGuid.trim().toLowerCase();
  if (!GUID_RE.test(guid)) throw new RangeError("article id must be a GUID");
  return `-- name: subscriberArticles:${guid}
SELECT SubscriberGuid, ImmediateAttempted, DigestAttempted, HardBounced
  FROM dbo.SubscriberArticle WHERE ArticleGuid = '${guid}'`;
}

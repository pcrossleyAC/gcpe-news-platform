export const Q_MINISTRIES = `-- name: ministries
SELECT m.Id, m.[Key], m.SortOrder, m.DisplayName, m.Abbreviation, m.IsActive,
       m.MinisterEmail, m.MinisterPhotoUrl, m.MinisterPageHtml, m.MinisterAddress, m.MinisterName, m.MinisterSummary,
       m.MinistryUrl, p.[Key] AS ParentKey, m.WeekendContactNumber, m.DisplayAdditionalName,
       m.TwitterUsername, m.FlickrUrl, m.YoutubeUrl, m.AudioUrl,
       m.ContactUserId, c1.FullName AS ContactFullName, c1.PhoneNumber AS ContactPhone, c1.MobileNumber AS ContactMobile, c1.EmailAddress AS ContactEmail,
       m.SecondContactUserId, c2.FullName AS SecondContactFullName, c2.PhoneNumber AS SecondContactPhone, c2.MobileNumber AS SecondContactMobile, c2.EmailAddress AS SecondContactEmail
FROM dbo.Ministry m
LEFT JOIN dbo.Ministry p ON p.Id = m.ParentId
LEFT JOIN calendar.SystemUser c1 ON c1.Id = m.ContactUserId
LEFT JOIN calendar.SystemUser c2 ON c2.Id = m.SecondContactUserId`;

export const Q_MINISTRY_TOPICS = `-- name: ministryTopics
SELECT MinistryId, SortIndex, LinkText, LinkUrl FROM dbo.MinistryTopic`;

export const Q_MINISTRY_SERVICES = `-- name: ministryServices
SELECT MinistryId, SortIndex, LinkText, LinkUrl FROM dbo.MinistryService`;

export const Q_MINISTRY_SECTORS = `-- name: ministrySectors
SELECT ms.MinistryId, s.[Key] AS SectorKey FROM dbo.MinistrySector ms JOIN dbo.Sector s ON s.Id = ms.SectorId`;

export const Q_SECTORS = `-- name: sectors
SELECT s.Id, s.[Key], s.SortOrder, s.IsActive, s.DisplayName, sl.Name AS EnglishName,
       s.TwitterUsername, s.FlickrUrl, s.YoutubeUrl, s.AudioUrl
FROM dbo.Sector s
LEFT JOIN dbo.SectorLanguage sl ON sl.SectorId = s.Id AND sl.LanguageId = 4105`;

export const Q_THEMES = `-- name: themes
SELECT Id, [Key], SortOrder, IsActive, DisplayName FROM dbo.Theme`;

export const Q_TAGS = `-- name: tags
SELECT Id, [Key], SortOrder, IsActive, DisplayName FROM dbo.Tag`;

export const Q_SERVICES = `-- name: services
SELECT Id, [Key], SortOrder, IsActive, DisplayName FROM dbo.Service`;

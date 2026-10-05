/*
  05 — Hub Contacts / media (media.* schema). Run in Gcpe.Hub. Read-only; returns no personal
  data (contacts are counted, never listed). See README.md.
  Contacts move to Media Hub; this only sizes the old module and its link to NoD media lists (§5.3
  of the Phase 4 spec). Media Requests are out of scope and are only counted.
*/
USE [Gcpe.Hub];   -- change if your Hub database is named differently
SET NOCOUNT ON;
SET TRANSACTION ISOLATION LEVEL READ UNCOMMITTED;

-- 5.1 Contacts and outlets: counts by flags.
SELECT IsActive, IsPressGallery, IsPrimaryMediaContact, IsSecondaryMediaContact, HasMinisterAssignment,
       COUNT(*) AS contacts, MAX(ModifiedDate) AS last_modified
FROM media.Contact
GROUP BY IsActive, IsPressGallery, IsPrimaryMediaContact, IsSecondaryMediaContact, HasMinisterAssignment
ORDER BY contacts DESC;
SELECT IsActive, IsOutlet, IsMajorMedia, IsEthnicMedia, IsLiveMedia, COUNT(*) AS companies, MAX(ModifiedDate) AS last_modified
FROM media.Company
GROUP BY IsActive, IsOutlet, IsMajorMedia, IsEthnicMedia, IsLiveMedia
ORDER BY companies DESC;

-- 5.2 Contact web addresses (where contact emails live) by type: counts only.
SELECT t.*, (SELECT COUNT(*) FROM media.ContactWebAddress w WHERE w.WebAddressTypeId = t.Id) AS contact_addresses,
       (SELECT COUNT(*) FROM media.CompanyWebAddress w WHERE w.WebAddressTypeId = t.Id) AS company_addresses
FROM media.WebAddressType t;

-- 5.3 Company distribution lists (names are list names, not people) and their sizes.
SELECT d.Id, d.DistributionName, d.SortOrder, d.ModifiedDate,
       (SELECT COUNT(*) FROM media.CompanyDistribution cd WHERE cd.DistributionId = d.Id) AS companies
FROM media.Distribution d ORDER BY d.SortOrder;

-- 5.4 Settings (secret-looking values masked).
SELECT ConfigKey,
       CASE WHEN ConfigKey LIKE '%pass%' OR ConfigKey LIKE '%pwd%' OR ConfigKey LIKE '%secret%' OR ConfigKey LIKE '%key%'
              OR ConfigKey LIKE '%token%' OR ConfigKey LIKE '%connection%' OR ConfigKey LIKE '%credential%'
            THEN '***' ELSE ConfigValue END AS ConfigValue,
       ConfigDataType, ConfigDescription
FROM media.SysConfig ORDER BY ConfigKey;

-- 5.5 Activity in the module: edits per year, and Media Requests per year (counts only).
SELECT YEAR(ModifiedDate) AS yr, COUNT(*) AS contacts_modified FROM media.Contact GROUP BY YEAR(ModifiedDate) ORDER BY yr;
SELECT YEAR(CreatedAt) AS yr, IsActive, COUNT(*) AS media_requests FROM media.MediaRequest
GROUP BY YEAR(CreatedAt), IsActive ORDER BY yr;

-- 5.6 Audit log of the module: actions per year.
SELECT YEAR(EventDate) AS yr, [Action], EntityType, COUNT(*) AS events
FROM media.SysLog GROUP BY YEAR(EventDate), [Action], EntityType ORDER BY yr, events DESC;

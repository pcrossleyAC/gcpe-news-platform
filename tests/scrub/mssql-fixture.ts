import { randomBytes } from "node:crypto";
import type sql from "mssql";
import { openPool, type MssqlConfig } from "../../scripts/lib/scrub/mssql";

export function mssqlTestConfig(env: NodeJS.ProcessEnv = process.env): MssqlConfig | null {
  const password = env.SCRUB_TEST_MSSQL_PASSWORD;
  if (!password) return null;
  return { server: env.SCRUB_TEST_MSSQL_SERVER ?? "127.0.0.1", port: Number(env.SCRUB_TEST_MSSQL_PORT ?? 1433), user: env.SCRUB_TEST_MSSQL_USER ?? "sa", password, trustServerCertificate: true };
}
export const SKIP_MESSAGE = "SQL Server scrub tests skipped: set SCRUB_TEST_MSSQL_PASSWORD (and SCRUB_TEST_MSSQL_SERVER/USER/PORT unless 127.0.0.1/sa/1433) to run them";

export const FIXTURE_KEY = "e".repeat(64);
/** 2026-10-22 12:00 in BC, as an instant and as legacy's wall-clock DATETIME. */
export const REF_UTC = new Date("2026-10-22T19:00:00Z");
export const REF_WALL = new Date(Date.UTC(2026, 9, 22, 12, 0, 0));

const g = (prefix: string, n: number) => `${prefix}000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
export const ID = {
  R1: g("10", 1), R2: g("10", 2), R3: g("10", 3), R4: g("10", 4),
  D1: g("20", 1), D2: g("20", 2), D3: g("20", 3), D4: g("20", 4),
  C1: g("30", 1), C2: g("30", 2), S1: g("40", 1), S2: g("40", 2),
  B1: g("50", 1), B2: g("50", 2), IMG1: g("60", 1), M1: g("70", 1), SEC1: g("71", 1), TH1: g("72", 1),
  U1: g("80", 1), MC1: g("90", 1), MRR1: g("a0", 1), L1: g("b0", 1),
};

const ACTIVITY_JOINS = ["ActivityCategories", "ActivityCommunicationMaterials", "ActivityInitiatives", "ActivityNROrigins", "ActivitySectors", "ActivitySharedWith"];
const SCHEMA_SQL = [
  "CREATE SCHEMA calendar", "CREATE SCHEMA media", "CREATE SCHEMA dashboard",
  "CREATE TABLE calendar.SystemUser (Id int PRIMARY KEY, Username nvarchar(20) NULL, FullName nvarchar(50) NULL, DisplayName nvarchar(50) NULL, EmailAddress nvarchar(50) NULL, PhoneNumber nvarchar(20) NULL, MobileNumber nvarchar(15) NULL, JobTitle nvarchar(100) NULL, Description nvarchar(2000) NULL, CreatedDateTime datetime NULL, LastUpdatedDateTime datetime NULL)",
  "CREATE TABLE calendar.CommunicationContact (Id int PRIMARY KEY, SystemUserId int NULL, Name nvarchar(100) NULL)",
  "CREATE TABLE calendar.GovernmentRepresentative (Id int PRIMARY KEY, Name nvarchar(50) NULL, Description nvarchar(84) NULL)",
  "CREATE TABLE calendar.EventPlanner (Id int PRIMARY KEY, Name nvarchar(100) NULL, PhoneNumber nvarchar(50) NULL, JobTitle nvarchar(150) NULL)",
  "CREATE TABLE calendar.Videographer (Id int PRIMARY KEY, Name nvarchar(100) NULL, JobTitle nvarchar(150) NULL)",
  "CREATE TABLE calendar.Activity (Id int PRIMARY KEY, StartDateTime datetime NULL, EndDateTime datetime NULL, NRDateTime datetime NULL, Title nvarchar(500) NULL, Comments nvarchar(4000) NULL, IsActive bit NOT NULL, IsConfidential bit NULL, CreatedDateTime datetime NULL, LastUpdatedDateTime datetime NULL)",
  ...ACTIVITY_JOINS.map((t) => `CREATE TABLE calendar.${t} (Id int IDENTITY PRIMARY KEY, ActivityId int NOT NULL, CreatedDateTime datetime NULL, LastUpdatedDateTime datetime NOT NULL)`),
  "CREATE TABLE calendar.ActivityKeywords (ActivityId int NOT NULL, KeywordId int NOT NULL, LastUpdatedDateTime datetime NOT NULL, PRIMARY KEY (ActivityId, KeywordId))",
  "CREATE TABLE calendar.ActivityTags (ActivityId int NOT NULL, TagId uniqueidentifier NOT NULL, CreatedDateTime datetime NOT NULL, LastUpdatedDateTime datetime NOT NULL, PRIMARY KEY (ActivityId, TagId))",
  "CREATE TABLE calendar.ActivityThemes (ActivityId int NOT NULL, ThemeId uniqueidentifier NOT NULL, CreatedDateTime datetime NOT NULL, LastUpdatedDateTime datetime NOT NULL, PRIMARY KEY (ActivityId, ThemeId))",
  "CREATE TABLE calendar.FavoriteActivity (ActivityId int NOT NULL, SystemUserId int NOT NULL, PRIMARY KEY (ActivityId, SystemUserId))",
  "CREATE TABLE calendar.Log (Id int PRIMARY KEY, ActivityId int NOT NULL, TableName nvarchar(50) NULL, FieldName nvarchar(1000) NULL, OldValue nvarchar(1000) NULL, NewValue nvarchar(1000) NULL, Operation nvarchar(50) NULL, CreatedDateTime datetime NULL, LastUpdatedDateTime datetime NOT NULL)",
  "CREATE TABLE calendar.NewsFeed (Id int PRIMARY KEY, ActivityId int NULL, Text nvarchar(1000) NULL, CreatedDateTime datetime NULL)",
  "CREATE TABLE calendar.ActivityFiles (Id int PRIMARY KEY, ActivityId int NOT NULL, FileName varchar(max) NULL, Data varbinary(max) NOT NULL, LastUpdatedDateTime datetime NOT NULL)",
  "CREATE TABLE calendar.ActivityFilter (Id int PRIMARY KEY, Name nvarchar(200) NULL, QueryString nvarchar(300) NULL, CreatedDateTime datetime NULL, LastUpdatedDateTime datetime NULL)",
  "CREATE TABLE dbo.[User] (Id uniqueidentifier PRIMARY KEY, DisplayName nvarchar(256) NOT NULL, EmailAddress nvarchar(256) NOT NULL, IsActive bit NOT NULL)",
  "CREATE TABLE dbo.NewsRelease (Id uniqueidentifier PRIMARY KEY, [Key] varchar(255) NOT NULL, Reference varchar(50) NOT NULL, AtomId varchar(255) NOT NULL, IsCommitted bit NOT NULL, IsPublished bit NOT NULL, IsActive bit NOT NULL, PublishDateTime datetimeoffset NULL, ActivityId int NULL, Keywords nvarchar(max) NOT NULL)",
  "CREATE TABLE dbo.NewsReleaseLanguage (ReleaseId uniqueidentifier NOT NULL, LanguageId int NOT NULL, Summary nvarchar(max) NULL, PRIMARY KEY (ReleaseId, LanguageId))",
  "CREATE TABLE dbo.NewsReleaseDocument (Id uniqueidentifier PRIMARY KEY, ReleaseId uniqueidentifier NOT NULL)",
  "CREATE TABLE dbo.NewsReleaseDocumentLanguage (DocumentId uniqueidentifier NOT NULL, LanguageId int NOT NULL, Headline nvarchar(255) NULL, BodyHtml nvarchar(max) NULL, PRIMARY KEY (DocumentId, LanguageId))",
  "CREATE TABLE dbo.NewsReleaseDocumentContact (DocumentId uniqueidentifier NOT NULL, LanguageId int NOT NULL, SortIndex int NOT NULL, Information nvarchar(250) NULL, PRIMARY KEY (DocumentId, LanguageId, SortIndex))",
  "CREATE TABLE dbo.NewsReleaseLog (Id int PRIMARY KEY, ReleaseId uniqueidentifier NOT NULL, Description nvarchar(200) NULL, UserId uniqueidentifier NULL)",
  ...["MediaDistribution:MediaDistributionListId", "Ministry:MinistryId", "Sector:SectorId", "Tag:TagId", "Theme:ThemeId"].map((x) => { const [t, c] = x.split(":"); return `CREATE TABLE dbo.NewsRelease${t} (ReleaseId uniqueidentifier NOT NULL, ${c} uniqueidentifier NOT NULL, PRIMARY KEY (ReleaseId, ${c}))`; }),
  "CREATE TABLE dbo.Blob (Id uniqueidentifier PRIMARY KEY, Data varbinary(max) NOT NULL)",
  "CREATE TABLE dbo.NewsReleaseHistory (ReleaseId uniqueidentifier NOT NULL, PublishDateTime datetimeoffset NOT NULL, MimeType varchar(100) NOT NULL, BlobId uniqueidentifier NOT NULL, PRIMARY KEY (ReleaseId, PublishDateTime, MimeType))",
  "CREATE TABLE dbo.NewsReleaseImage (Id uniqueidentifier PRIMARY KEY, BlobId uniqueidentifier NULL, Name varchar(50) NULL)",
  "CREATE TABLE dbo.Ministry (Id uniqueidentifier PRIMARY KEY, [Key] nvarchar(100) NOT NULL, TopReleaseId uniqueidentifier NULL, FeatureReleaseId uniqueidentifier NULL, MinisterName nvarchar(255) NULL, MinisterEmail nvarchar(255) NULL, MinisterSummary nvarchar(max) NULL)",
  "CREATE TABLE dbo.Sector (Id uniqueidentifier PRIMARY KEY, [Key] varchar(100) NOT NULL, TopReleaseId uniqueidentifier NULL, FeatureReleaseId uniqueidentifier NULL)",
  "CREATE TABLE dbo.Theme (Id uniqueidentifier PRIMARY KEY, [Key] varchar(255) NOT NULL, TopReleaseId uniqueidentifier NULL, FeatureReleaseId uniqueidentifier NULL)",
  "CREATE TABLE dbo.ApplicationSetting (SettingName varchar(100) PRIMARY KEY, SettingValue nvarchar(max) NOT NULL)",
  "CREATE TABLE dbo.Carousel (Id uniqueidentifier PRIMARY KEY, PublishDateTime datetimeoffset NULL)",
  "CREATE TABLE dbo.Slide (Id uniqueidentifier PRIMARY KEY, Headline nvarchar(255) NULL, Summary nvarchar(max) NULL)",
  "CREATE TABLE dbo.CarouselSlide (CarouselId uniqueidentifier NOT NULL, SlideId uniqueidentifier NOT NULL, SortIndex int NOT NULL, PRIMARY KEY (CarouselId, SlideId))",
  "CREATE TABLE dbo.MediaRequestResolution (Id uniqueidentifier PRIMARY KEY, DisplayAs nvarchar(50) NULL)",
  "CREATE TABLE media.Contact (Id uniqueidentifier PRIMARY KEY, FirstName nvarchar(150) NULL, LastName nvarchar(150) NULL)",
  "CREATE TABLE dashboard.UserMinistryPreference (MinistryId uniqueidentifier NOT NULL, Email nvarchar(50) NOT NULL, PRIMARY KEY (MinistryId, Email))",
];

const DATA_SQL = [
  `INSERT calendar.SystemUser (Id, Username, FullName, DisplayName, EmailAddress, PhoneNumber, MobileNumber, Description, CreatedDateTime, LastUpdatedDateTime) VALUES
    (1, N'qashbury', N'Quill Ashbury', N'Ashbury, Quill', N'quill.ashbury@gov.example', N'(604) 555-0142', N'604.555.0143', N'Back-up: Marisol Tennant-Vey', '20250101 09:00', '20261001 09:00'),
    (2, N'mtv', N'Marisol Tennant-Vey', N'Marisol Tennant-Vey', N'MARISOL.TV@gov.example', NULL, NULL, NULL, '20250101 09:00', '20250101 09:00'),
    (3, NULL, NULL, N'Admin', NULL, NULL, NULL, NULL, NULL, NULL),
    (4, N'treyes', N'Tobin Reyes-Hart', N'Tobin Reyes-Hart', N'tobin at gov', NULL, NULL, NULL, NULL, NULL)`,
  "INSERT calendar.CommunicationContact (Id, SystemUserId, Name) VALUES (1, 1, N'Quill Ashbury')",
  `INSERT calendar.GovernmentRepresentative (Id, Name, Description) VALUES (1, N'Hon. Dorian Feld', NULL), (2, N'Premier', NULL), (3, N'Hon. Dorian Feld', N'${"x".repeat(70)} a@gov.example')`,
  "INSERT calendar.EventPlanner (Id, Name, PhoneNumber) VALUES (1, N'Ines Okafor-Lind', N'250.555.0161')",
  "INSERT calendar.Videographer (Id, Name) VALUES (1, N'Tobin Reyes-Hart')",
  `INSERT calendar.Activity (Id, StartDateTime, EndDateTime, NRDateTime, Title, Comments, IsActive, IsConfidential, CreatedDateTime, LastUpdatedDateTime) VALUES
    (1, '20261012 09:00', '20261012 10:00', '20261012 08:00', N'Visit with Quill Ashbury', N'Ask Ines Okafor-Lind (250.555.0161) or press@news.example. Wynona Brightwater''s interview; Ashbury, Quill to attend.', 1, 0, '20261001 10:00', '20261005 10:00'),
    (2, '20261027 09:00', '20261027 10:00', NULL, N'Future announcement', N'Not yet public', 1, 0, '20261001 10:00', '20261001 10:00'),
    (3, '20261001 09:00', '20261001 10:00', NULL, N'Confidential briefing', N'Confidential', 1, 1, '20260901 10:00', '20260901 10:00'),
    (4, '20261001 09:00', NULL, NULL, N'No end date', NULL, 1, 0, '20260901 10:00', '20260901 10:00'),
    (5, '20260901 09:00', '20260901 10:00', NULL, N'Deleted but ended', NULL, 0, 0, '20260801 10:00', '20260801 10:00')`,
  ...ACTIVITY_JOINS.map((t) => `INSERT calendar.${t} (ActivityId, CreatedDateTime, LastUpdatedDateTime) VALUES (1, '20261001 10:00', '20261001 10:00'), (2, '20261001 10:00', '20261001 10:00'), (3, '20261001 10:00', '20261001 10:00'), (5, '20261001 10:00', '20261001 10:00')`),
  "INSERT calendar.ActivityKeywords (ActivityId, KeywordId, LastUpdatedDateTime) VALUES (1, 1, '20261001 10:00'), (2, 1, '20261001 10:00')",
  `INSERT calendar.ActivityTags (ActivityId, TagId, CreatedDateTime, LastUpdatedDateTime) VALUES (1, '${ID.TH1}', '20261001 10:00', '20261001 10:00'), (3, '${ID.TH1}', '20261001 10:00', '20261001 10:00')`,
  `INSERT calendar.ActivityThemes (ActivityId, ThemeId, CreatedDateTime, LastUpdatedDateTime) VALUES (1, '${ID.TH1}', '20261001 10:00', '20261001 10:00'), (4, '${ID.TH1}', '20261001 10:00', '20261001 10:00')`,
  "INSERT calendar.FavoriteActivity (ActivityId, SystemUserId) VALUES (1, 1), (2, 1), (3, 2)",
  `INSERT calendar.Log (Id, ActivityId, TableName, FieldName, OldValue, NewValue, Operation, CreatedDateTime, LastUpdatedDateTime) VALUES
    (1, 1, N'Activity', N'StartDateTime', N'10/5/2026 9:00:00 AM', N'10/12/2026 9:00:00 AM', N'Update', '20261005 10:00', '20261005 10:00'),
    (2, 1, N'Activity', N'Title', N'Plan with Quill Ashbury', N'Visit with Quill Ashbury', N'Update', '20261005 10:00', '20261005 10:00'),
    (3, 2, N'Activity', N'Title', N'Old', N'Future announcement', N'Update', '20261001 10:00', '20261001 10:00')`,
  "INSERT calendar.NewsFeed (Id, ActivityId, Text, CreatedDateTime) VALUES (1, 1, N'Quill Ashbury changed the title', '20261005 10:00')",
  "INSERT calendar.ActivityFiles (Id, ActivityId, FileName, Data, LastUpdatedDateTime) VALUES (1, 1, 'notes.pdf', 0x255044462D, '20261005 10:00')",
  "INSERT calendar.ActivityFilter (Id, Name, QueryString, CreatedDateTime, LastUpdatedDateTime) VALUES (1, N'Quill Ashbury events', N'q=Ashbury', '20261001 10:00', '20261001 10:00')",
  `INSERT dbo.[User] (Id, DisplayName, EmailAddress, IsActive) VALUES ('${ID.U1}', N'Quill Ashbury', N'Quill.Ashbury@gov.example', 1)`,
  `INSERT dbo.NewsRelease (Id, [Key], Reference, AtomId, IsCommitted, IsPublished, IsActive, PublishDateTime, ActivityId, Keywords) VALUES
    ('${ID.R1}', '2026HLTH0001-000001', 'NEWS-00001', 'atom-1', 1, 1, 1, '2026-10-01T10:00:00-07:00', 1, N'health'),
    ('${ID.R2}', '2026HLTH0002-000002', 'NEWS-00002', 'atom-2', 0, 0, 1, NULL, NULL, N'draft'),
    ('${ID.R3}', '2026HLTH0003-000003', 'NEWS-00003', 'atom-3', 1, 1, 1, '2026-11-15T10:00:00-08:00', NULL, N'scheduled'),
    ('${ID.R4}', '2026HLTH0004-000004', 'NEWS-00004', 'atom-4', 1, 1, 1, '2026-10-02T10:00:00-07:00', 2, N'linked')`,
  `INSERT dbo.NewsReleaseLanguage (ReleaseId, LanguageId, Summary) VALUES ('${ID.R1}', 4105, N'Quill Ashbury announces'), ('${ID.R2}', 4105, N'Draft')`,
  `INSERT dbo.NewsReleaseDocument (Id, ReleaseId) VALUES ('${ID.D1}', '${ID.R1}'), ('${ID.D2}', '${ID.R2}'), ('${ID.D3}', '${ID.R3}'), ('${ID.D4}', '${ID.R4}')`,
  `INSERT dbo.NewsReleaseDocumentLanguage (DocumentId, LanguageId, Headline, BodyHtml) VALUES
    ('${ID.D1}', 4105, N'Clinic opens', N'<p>Minister <b>Dorian</b> Feld and Quill&nbsp;Ashbury''s team. Call 1-800-555-0142.</p>'),
    ('${ID.D2}', 4105, N'Draft', N'<p>Unpublished</p>'), ('${ID.D3}', 4105, N'Scheduled', N'<p>Embargoed</p>'), ('${ID.D4}', 4105, N'Linked', N'<p>Linked</p>')`,
  `INSERT dbo.NewsReleaseDocumentContact (DocumentId, LanguageId, SortIndex, Information) VALUES ('${ID.D1}', 4105, 0, N'Media Relations' + CHAR(10) + N'Quill Ashbury' + CHAR(10) + N'604-555-0142'), ('${ID.D2}', 4105, 0, N'Draft contact')`,
  `INSERT dbo.NewsReleaseLog (Id, ReleaseId, Description, UserId) VALUES (1, '${ID.R1}', N'Approved by Quill Ashbury', '${ID.U1}'), (2, '${ID.R2}', N'Created', NULL)`,
  `INSERT dbo.NewsReleaseMinistry (ReleaseId, MinistryId) VALUES ('${ID.R1}', '${ID.M1}'), ('${ID.R2}', '${ID.M1}')`,
  `INSERT dbo.Blob (Id, Data) VALUES ('${ID.B1}', 0x01), ('${ID.B2}', 0x02)`,
  `INSERT dbo.NewsReleaseHistory (ReleaseId, PublishDateTime, MimeType, BlobId) VALUES ('${ID.R1}', '2026-10-01T10:00:00-07:00', 'application/pdf', '${ID.B1}')`,
  `INSERT dbo.NewsReleaseImage (Id, BlobId, Name) VALUES ('${ID.IMG1}', '${ID.B2}', 'letterhead')`,
  `INSERT dbo.Ministry (Id, [Key], TopReleaseId, FeatureReleaseId, MinisterName, MinisterEmail, MinisterSummary) VALUES ('${ID.M1}', N'health', '${ID.R2}', '${ID.R1}', N'Hon. Dorian Feld', N'dorian.feld@gov.example', N'<p>Dorian Feld was elected in 2024.</p>')`,
  `INSERT dbo.Sector (Id, [Key], TopReleaseId, FeatureReleaseId) VALUES ('${ID.SEC1}', 'health', '${ID.R3}', NULL)`,
  `INSERT dbo.Theme (Id, [Key], TopReleaseId, FeatureReleaseId) VALUES ('${ID.TH1}', 'care', NULL, '${ID.R4}')`,
  `INSERT dbo.ApplicationSetting (SettingName, SettingValue) VALUES ('HomeTopReleaseId', N'${ID.R2}'), ('HomeFeatureReleaseId', N'${ID.R1}'), ('granville', N'<p>Call 1-800-555-0142</p>')`,
  `INSERT dbo.Carousel (Id, PublishDateTime) VALUES ('${ID.C1}', '2026-10-01T10:00:00-07:00'), ('${ID.C2}', '2026-12-01T10:00:00-08:00')`,
  `INSERT dbo.Slide (Id, Headline, Summary) VALUES ('${ID.S1}', N'Live now', N'Quill Ashbury explains'), ('${ID.S2}', N'Coming soon', N'Embargoed slide')`,
  `INSERT dbo.CarouselSlide (CarouselId, SlideId, SortIndex) VALUES ('${ID.C1}', '${ID.S1}', 0), ('${ID.C2}', '${ID.S2}', 0)`,
  `INSERT dbo.MediaRequestResolution (Id, DisplayAs) VALUES ('${ID.MRR1}', N'Resolved')`,
  `INSERT media.Contact (Id, FirstName, LastName) VALUES ('${ID.MC1}', N'Wynona', N'Brightwater')`,
  `INSERT dashboard.UserMinistryPreference (MinistryId, Email) VALUES ('${ID.M1}', N'someone@gov.example')`,
];

export async function createFixture(cfg: MssqlConfig): Promise<{ name: string; pool: sql.ConnectionPool; drop(): Promise<void> }> {
  const name = `ScrubFixture_${randomBytes(6).toString("hex")}_Scrubbed`;
  const master = await openPool(cfg, "master");
  try { await master.request().query(`CREATE DATABASE [${name}]`); } finally { await master.close(); }
  const pool = await openPool(cfg, name);
  for (const s of [...SCHEMA_SQL, ...DATA_SQL]) await pool.request().query(s);
  return {
    name,
    pool,
    async drop() {
      await pool.close();
      const m = await openPool(cfg, "master");
      try { await m.request().query(`ALTER DATABASE [${name}] SET SINGLE_USER WITH ROLLBACK IMMEDIATE; DROP DATABASE [${name}];`); } finally { await m.close(); }
    },
  };
}

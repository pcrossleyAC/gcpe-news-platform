export const ACTIVITY_CHILD_TABLES = [
  "calendar.ActivityCategories", "calendar.ActivityCommunicationMaterials", "calendar.ActivityInitiatives", "calendar.ActivityKeywords",
  "calendar.ActivityNROrigins", "calendar.ActivitySectors", "calendar.ActivitySharedWith", "calendar.ActivityTags", "calendar.ActivityThemes",
  "calendar.FavoriteActivity", "calendar.Log",
] as const;

/** Read by no importer, or out of scope, and holding people or unpublished content. */
export const EMPTIED_TABLES = ["calendar.NewsFeed", "calendar.ActivityFiles", "dbo.NewsReleaseHistory", "dbo.MediaRequestResolution"] as const;
export const EMPTIED_SCHEMAS = ["media", "dashboard"] as const;

export const REQUIRED_TABLES = [
  "calendar.Activity", ...ACTIVITY_CHILD_TABLES, "calendar.NewsFeed", "calendar.ActivityFiles", "calendar.ActivityFilter",
  "calendar.SystemUser", "calendar.CommunicationContact", "calendar.GovernmentRepresentative", "calendar.EventPlanner", "calendar.Videographer",
  "dbo.NewsRelease", "dbo.NewsReleaseLanguage", "dbo.NewsReleaseDocument", "dbo.NewsReleaseDocumentLanguage", "dbo.NewsReleaseDocumentContact",
  "dbo.NewsReleaseLog", "dbo.NewsReleaseMediaDistribution", "dbo.NewsReleaseMinistry", "dbo.NewsReleaseSector", "dbo.NewsReleaseTag",
  "dbo.NewsReleaseTheme", "dbo.NewsReleaseHistory", "dbo.NewsReleaseImage", "dbo.Blob", "dbo.Ministry", "dbo.Sector", "dbo.Theme",
  "dbo.ApplicationSetting", "dbo.Carousel", "dbo.CarouselSlide", "dbo.Slide", "dbo.User", "dbo.MediaRequestResolution", "media.Contact",
] as const;

/** Keys and references other rows and URLs depend on; never rewritten (the gates still read them). */
export const IDENTIFIER_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  "dbo.NewsRelease": ["Key", "Reference", "AtomId"],
  "dbo.Ministry": ["Key"],
  "dbo.Sector": ["Key"],
  "dbo.Tag": ["Key"],
  "dbo.Theme": ["Key"],
  "dbo.MediaDistributionList": ["Key"],
};

export interface PeopleQuery { source: string; sql: string; linkSource?: string; alwaysPerson?: boolean }
const NULLS = (cols: string[]) => cols.map((c) => `CAST(NULL AS nvarchar(50)) AS ${c}`).join(", ");
export const PEOPLE_QUERIES: readonly PeopleQuery[] = [
  { source: "calendar.SystemUser", alwaysPerson: true, sql: `SELECT CAST(Id AS nvarchar(50)) AS Id, FullName AS Name1, DisplayName AS Name2, EmailAddress AS Email, PhoneNumber AS Phone1, MobileNumber AS Phone2, ${NULLS(["LinkId"])} FROM calendar.SystemUser` },
  { source: "dbo.User", alwaysPerson: true, sql: `SELECT CAST(Id AS nvarchar(50)) AS Id, DisplayName AS Name1, EmailAddress AS Email, ${NULLS(["Name2", "Phone1", "Phone2", "LinkId"])} FROM dbo.[User]` },
  { source: "calendar.CommunicationContact", linkSource: "calendar.SystemUser", sql: `SELECT CAST(Id AS nvarchar(50)) AS Id, Name AS Name1, CAST(SystemUserId AS nvarchar(50)) AS LinkId, ${NULLS(["Name2", "Email", "Phone1", "Phone2"])} FROM calendar.CommunicationContact` },
  { source: "calendar.GovernmentRepresentative", sql: `SELECT CAST(Id AS nvarchar(50)) AS Id, Name AS Name1, ${NULLS(["Name2", "Email", "Phone1", "Phone2", "LinkId"])} FROM calendar.GovernmentRepresentative` },
  { source: "calendar.EventPlanner", sql: `SELECT CAST(Id AS nvarchar(50)) AS Id, Name AS Name1, PhoneNumber AS Phone1, ${NULLS(["Name2", "Email", "Phone2", "LinkId"])} FROM calendar.EventPlanner` },
  { source: "calendar.Videographer", sql: `SELECT CAST(Id AS nvarchar(50)) AS Id, Name AS Name1, ${NULLS(["Name2", "Email", "Phone1", "Phone2", "LinkId"])} FROM calendar.Videographer` },
  { source: "dbo.Ministry", sql: `SELECT CAST(Id AS nvarchar(50)) AS Id, MinisterName AS Name1, MinisterEmail AS Email, ${NULLS(["Name2", "Phone1", "Phone2", "LinkId"])} FROM dbo.Ministry` },
  { source: "media.Contact", sql: `SELECT CAST(Id AS nvarchar(50)) AS Id, NULLIF(LTRIM(RTRIM(CONCAT(FirstName, N' ', LastName))), N'') AS Name1, ${NULLS(["Name2", "Email", "Phone1", "Phone2", "LinkId"])} FROM media.Contact` },
];

export interface StructuredSpec { source: string; table: string; columns: Readonly<Record<string, "full" | "email" | "phone" | "username">> }
/** Columns that hold a person's own name, email, phone or user name: overwritten with their fictional identity. */
export const STRUCTURED: readonly StructuredSpec[] = [
  { source: "calendar.SystemUser", table: "calendar.SystemUser", columns: { FullName: "full", DisplayName: "full", EmailAddress: "email", PhoneNumber: "phone", MobileNumber: "phone", Username: "username" } },
  { source: "dbo.User", table: "dbo.User", columns: { DisplayName: "full", EmailAddress: "email" } },
  { source: "calendar.CommunicationContact", table: "calendar.CommunicationContact", columns: { Name: "full" } },
  { source: "calendar.GovernmentRepresentative", table: "calendar.GovernmentRepresentative", columns: { Name: "full" } },
  { source: "calendar.EventPlanner", table: "calendar.EventPlanner", columns: { Name: "full", PhoneNumber: "phone" } },
  { source: "calendar.Videographer", table: "calendar.Videographer", columns: { Name: "full" } },
  { source: "dbo.Ministry", table: "dbo.Ministry", columns: { MinisterName: "full", MinisterEmail: "email" } },
];

export const KEEP_RELEASE = "r.IsCommitted = 1 AND r.IsPublished = 1 AND r.IsActive = 1 AND r.PublishDateTime IS NOT NULL AND r.PublishDateTime <= @refUtc";
export const KEEP_ACTIVITY = "a.EndDateTime < @refWall AND a.IsConfidential = 0";

export function releaseScopeSql(): string {
  const gone = (col: string) => `NOT EXISTS (SELECT 1 FROM @keep k WHERE k.Id = ${col})`;
  return [
    "SET NOCOUNT ON;",
    "DECLARE @keep TABLE (Id uniqueidentifier PRIMARY KEY);",
    `INSERT @keep (Id) SELECT r.Id FROM dbo.NewsRelease r WHERE ${KEEP_RELEASE};`,
    ...["dbo.Ministry", "dbo.Sector", "dbo.Theme"].flatMap((t) => ["TopReleaseId", "FeatureReleaseId"].map((c) => `UPDATE ${t} SET ${c} = NULL WHERE ${c} IS NOT NULL AND ${gone(c)};`)),
    `UPDATE dbo.ApplicationSetting SET SettingValue = N'' WHERE SettingName IN ('HomeTopReleaseId', 'HomeFeatureReleaseId') AND (TRY_CONVERT(uniqueidentifier, SettingValue) IS NULL OR ${gone("TRY_CONVERT(uniqueidentifier, SettingValue)")});`,
    `DELETE c FROM dbo.NewsReleaseDocumentContact c JOIN dbo.NewsReleaseDocument d ON d.Id = c.DocumentId WHERE ${gone("d.ReleaseId")};`,
    `DELETE l FROM dbo.NewsReleaseDocumentLanguage l JOIN dbo.NewsReleaseDocument d ON d.Id = l.DocumentId WHERE ${gone("d.ReleaseId")};`,
    `DELETE d FROM dbo.NewsReleaseDocument d WHERE ${gone("d.ReleaseId")};`,
    ...["dbo.NewsReleaseLanguage", "dbo.NewsReleaseLog", "dbo.NewsReleaseMediaDistribution", "dbo.NewsReleaseMinistry", "dbo.NewsReleaseSector", "dbo.NewsReleaseTag", "dbo.NewsReleaseTheme", "dbo.NewsReleaseHistory"].map((t) => `DELETE x FROM ${t} x WHERE ${gone("x.ReleaseId")};`),
    `DELETE r FROM dbo.NewsRelease r WHERE ${gone("r.Id")};`,
    "DELETE cs FROM dbo.CarouselSlide cs JOIN dbo.Carousel c ON c.Id = cs.CarouselId WHERE c.PublishDateTime IS NULL OR c.PublishDateTime > @refUtc;",
    "DELETE c FROM dbo.Carousel c WHERE c.PublishDateTime IS NULL OR c.PublishDateTime > @refUtc;",
    "DELETE s FROM dbo.Slide s WHERE NOT EXISTS (SELECT 1 FROM dbo.CarouselSlide cs WHERE cs.SlideId = s.Id);",
  ].join("\n");
}

export function activityScopeSql(): string {
  const gone = (col: string) => `NOT EXISTS (SELECT 1 FROM @act k WHERE k.Id = ${col})`;
  return [
    "SET NOCOUNT ON;",
    "DECLARE @act TABLE (Id int PRIMARY KEY);",
    `INSERT @act (Id) SELECT a.Id FROM calendar.Activity a WHERE ${KEEP_ACTIVITY};`,
    "DELETE FROM calendar.NewsFeed;",
    "DELETE FROM calendar.ActivityFiles;",
    ...ACTIVITY_CHILD_TABLES.map((t) => `DELETE x FROM ${t} x WHERE ${gone("x.ActivityId")};`),
    `UPDATE r SET ActivityId = NULL FROM dbo.NewsRelease r WHERE r.ActivityId IS NOT NULL AND ${gone("r.ActivityId")};`,
    `DELETE a FROM calendar.Activity a WHERE ${gone("a.Id")};`,
  ].join("\n");
}

export const BLOB_CLEANUP_SQL = "DELETE b FROM dbo.Blob b WHERE NOT EXISTS (SELECT 1 FROM dbo.NewsReleaseImage i WHERE i.BlobId = b.Id) AND NOT EXISTS (SELECT 1 FROM dbo.NewsReleaseHistory h WHERE h.BlobId = b.Id);";

const PART = /^[A-Za-z_][A-Za-z0-9_]*$/;
export function quoteName(table: string): string {
  const parts = table.split(".");
  if (parts.length !== 2 || !parts.every((p) => PART.test(p))) throw new Error("not a schema.table name");
  return parts.map((p) => `[${p}]`).join(".");
}
export function quoteCol(col: string): string {
  if (!PART.test(col)) throw new Error("not a column name");
  return `[${col}]`;
}

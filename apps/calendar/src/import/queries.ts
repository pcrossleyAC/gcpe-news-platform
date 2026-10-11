const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * The scope rule (spec addendum §12.1, R13) in SQL, to narrow the big reads. scope.ts applies the
 * same rule again in TypeScript. Legacy DATETIMEs are BC wall-clock values, so comparing them with
 * the cutoff date is "on or after 00:00 BC time". 'YYYYMMDD' is the one literal SQL Server reads
 * the same under every DATEFORMAT.
 */
export function activityScopeSql(cutoff: string, awarenessCategoryIds: readonly number[]): string {
  const m = DATE.exec(cutoff);
  if (!m) throw new Error("the cutoff must be YYYY-MM-DD");
  if (awarenessCategoryIds.some((n) => !Number.isSafeInteger(n) || n <= 0)) throw new Error("awareness category ids must be positive integers");
  const day = `${m[1]}${m[2]}${m[3]}`;
  const post = `(a.EndDateTime >= '${day}' OR a.StartDateTime >= '${day}')`;
  const awareness = awarenessCategoryIds.length === 0
    ? "1 = 0"
    : `(a.IsActive = 1 AND EXISTS (SELECT 1 FROM calendar.ActivityCategories ac WHERE ac.ActivityId = a.Id AND ac.IsActive = 1 AND ac.CategoryId IN (${awarenessCategoryIds.join(",")})))`;
  return `(${post} OR ${awareness})`;
}

const inScope = (scope: string, col: string) => `${col} IN (SELECT a.Id FROM calendar.Activity a WHERE ${scope})`;
const join = (name: string, table: string, value: string, scope: string) =>
  `-- name: ${name}\nSELECT j.ActivityId, j.${value} AS ValueId, j.IsActive FROM calendar.${table} j WHERE j.IsActive = 1 AND ${inScope(scope, "j.ActivityId")}`;
const lookup = (name: string, table: string, extra = "") => `-- name: ${name}\nSELECT Id, Name, SortOrder, IsActive${extra} FROM calendar.${table}`;

/** Every query the importer runs, keyed by its `-- name:`. */
export function Q(cutoff: string, awarenessCategoryIds: readonly number[]) {
  const s = activityScopeSql(cutoff, awarenessCategoryIds);
  return {
    activities: `-- name: activities\nSELECT a.* FROM calendar.Activity a WHERE ${s}`,
    activityCount: "-- name: activityCount\nSELECT COUNT(*) AS N FROM calendar.Activity",
    categories: join("activityCategories", "ActivityCategories", "CategoryId", s),
    commMaterials: join("activityCommMaterials", "ActivityCommunicationMaterials", "CommunicationMaterialId", s),
    initiatives: join("activityInitiatives", "ActivityInitiatives", "InitiativeId", s),
    keywords: join("activityKeywords", "ActivityKeywords", "KeywordId", s),
    nrOrigins: join("activityNrOrigins", "ActivityNROrigins", "NROriginId", s),
    sectors: join("activitySectors", "ActivitySectors", "SectorId", s),
    themes: join("activityThemes", "ActivityThemes", "ThemeId", s),
    tags: join("activityTags", "ActivityTags", "TagId", s),
    sharedWith: join("activitySharedWith", "ActivitySharedWith", "MinistryId", s),
    users:
      "-- name: users\nSELECT Id, RoleId, DisplayName, FullName, EmailAddress, IsActive, JobTitle, PhoneNumber, MobileNumber, Description, FilterDisplayValue, HiddenColumns, LastUpdatedDateTime FROM calendar.SystemUser",
    userMinistries: "-- name: userMinistries\nSELECT SystemUserId, MinistryId, IsActive FROM calendar.SystemUserMinistry WHERE IsActive = 1 AND SystemUserId IS NOT NULL AND MinistryId IS NOT NULL",
    commContacts: "-- name: commContacts\nSELECT Id, SystemUserId, MinistryId, SortOrder, IsActive FROM calendar.CommunicationContact",
    savedFilters: "-- name: savedFilters\nSELECT Id, CreatedBy, Name, QueryString, SortOrder, IsActive FROM calendar.ActivityFilter",
    favourites: `-- name: favourites\nSELECT f.SystemUserId, f.ActivityId FROM calendar.FavoriteActivity f WHERE ${inScope(s, "f.ActivityId")}`,
    favouriteCount: "-- name: favouriteCount\nSELECT COUNT(*) AS N FROM calendar.FavoriteActivity",
    files: `-- name: files\nSELECT f.Id, f.ActivityId, f.Data, f.FileName, f.FileType, f.FileLength, f.Md5, f.LastUpdatedDateTime, f.LastUpdatedBy FROM calendar.ActivityFiles f WHERE ${inScope(s, "f.ActivityId")}`,
    fileCount: "-- name: fileCount\nSELECT COUNT(*) AS N FROM calendar.ActivityFiles",
    logs: `-- name: logs\nSELECT l.Id, l.ActivityId, l.FieldName, l.OldValue, l.NewValue, l.Operation, l.CreatedDateTime, l.CreatedBy, l.LastUpdatedDateTime FROM calendar.Log l WHERE ${inScope(s, "l.ActivityId")}`,
    logCount: "-- name: logCount\nSELECT COUNT(*) AS N FROM calendar.Log",
    releaseLinks: "-- name: releaseLinks\nSELECT ActivityId, COUNT(*) AS N FROM dbo.NewsRelease WHERE ActivityId IS NOT NULL GROUP BY ActivityId",
    lkCategories: lookup("categories", "Category"),
    lkCities: lookup("cities", "City"),
    lkCommMaterials: lookup("commMaterials", "CommunicationMaterial"),
    lkEventPlanners: lookup("eventPlanners", "EventPlanner", ", PhoneNumber, JobTitle"),
    lkGovernmentRepresentatives: lookup("governmentRepresentatives", "GovernmentRepresentative", ", Description"),
    lkInitiatives: lookup("initiatives", "Initiative", ", ShortName"),
    lkKeywords: lookup("keywords", "Keyword"),
    lkNrDistributions: lookup("nrDistributions", "NRDistribution"),
    lkNrOrigins: lookup("nrOrigins", "NROrigin"),
    lkPremierRequested: lookup("premierRequested", "PremierRequested"),
    lkVideographers: lookup("videographers", "Videographer", ", JobTitle"),
  };
}

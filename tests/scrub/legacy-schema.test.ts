import { describe, expect, it } from "vitest";
import { ACTIVITY_CHILD_TABLES, activityScopeSql, EMPTIED_TABLES, IDENTIFIER_COLUMNS, KEEP_ACTIVITY, KEEP_RELEASE, PEOPLE_QUERIES, quoteCol, quoteName, releaseScopeSql, REQUIRED_TABLES, STRUCTURED } from "../../scripts/lib/scrub/legacy-schema";

const TEXT_COLUMNS: Record<string, string[]> = {
  "calendar.Activity": ["PotentialDates", "Title", "Details", "Schedule", "Significance", "Strategy", "Comments", "HqComments", "LeadOrganization", "Venue", "Translations", "OtherCity"],
  "calendar.ActivityFilter": ["QueryString", "Name"],
  "calendar.CommunicationContact": ["Name", "MinistryShortName"],
  "calendar.EventPlanner": ["Name", "PhoneNumber", "JobTitle"],
  "calendar.GovernmentRepresentative": ["Name", "Description"],
  "calendar.Log": ["TableName", "FieldName", "OldValue", "NewValue", "Operation"],
  "calendar.SystemUser": ["Username", "Description", "FullName", "DisplayName", "JobTitle", "PhoneNumber", "MobileNumber", "EmailAddress", "HiddenColumns"],
  "calendar.Videographer": ["Name", "JobTitle"],
  "dbo.ApplicationSetting": ["SettingName", "SettingValue"],
  "dbo.MediaDistributionList": ["Key", "DisplayName"],
  "dbo.Ministry": ["Key", "DisplayName", "Abbreviation", "MinisterEmail", "MinisterPhotoUrl", "MinisterPageHtml", "MiscHtml", "MiscRightHtml", "TwitterUsername", "FlickrUrl", "YoutubeUrl", "AudioUrl", "FacebookEmbedHtml", "YoutubeEmbedHtml", "AudioEmbedHtml", "MinisterAddress", "MinisterName", "MinisterSummary", "MinistryUrl", "WeekendContactNumber", "DisplayAdditionalName"],
  "dbo.NewsRelease": ["Key", "Reference", "AtomId", "Keywords", "AssetUrl", "RedirectUrl"],
  "dbo.NewsReleaseDocumentContact": ["Information"],
  "dbo.NewsReleaseDocumentLanguage": ["PageTitle", "Organizations", "Headline", "Subheadline", "Byline", "BodyHtml"],
  "dbo.NewsReleaseLanguage": ["Location", "Summary", "SocialMediaHeadline", "SocialMediaSummary"],
  "dbo.NewsReleaseLog": ["Description"],
  "dbo.NewsReleaseType": ["PageTitle"],
  "dbo.Sector": ["Key", "DisplayName", "MiscHtml", "MiscRightHtml", "TwitterUsername", "FlickrUrl", "YoutubeUrl", "AudioUrl", "FacebookEmbedHtml", "YoutubeEmbedHtml", "AudioEmbedHtml"],
  "dbo.Slide": ["Headline", "Summary", "ActionUrl", "FacebookPostUrl"],
  "dbo.Tag": ["Key", "DisplayName"],
  "dbo.Theme": ["Key", "DisplayName"],
  "dbo.User": ["DisplayName", "EmailAddress"],
};

describe("legacy table rules", () => {
  it("names only identifier columns that exist", () => {
    for (const [table, cols] of Object.entries(IDENTIFIER_COLUMNS)) for (const c of cols) expect(TEXT_COLUMNS[table], `${table}.${c}`).toContain(c);
  });

  it("rewrites only structured columns that exist", () => {
    for (const s of STRUCTURED) for (const c of Object.keys(s.columns)) expect(TEXT_COLUMNS[s.table], `${s.table}.${c}`).toContain(c);
  });

  it("reads every people source, with user, comm contact and crew rows always becoming people", () => {
    expect(PEOPLE_QUERIES.map((q) => q.source)).toEqual(["calendar.SystemUser", "dbo.User", "calendar.CommunicationContact", "calendar.GovernmentRepresentative", "calendar.EventPlanner", "calendar.Videographer", "dbo.Ministry", "media.Contact"]);
    expect(PEOPLE_QUERIES.filter((q) => q.alwaysPerson).map((q) => q.source)).toEqual(["calendar.SystemUser", "dbo.User", "calendar.CommunicationContact", "calendar.EventPlanner", "calendar.Videographer"]);
    for (const q of PEOPLE_QUERIES) for (const col of ["AS Id", "AS Name1", "AS Name2", "AS Email", "AS Phone1", "AS Phone2", "AS LinkId"]) expect(q.sql, q.source).toContain(col);
  });

  it("keeps only published, active, past releases and removes their dependants first", () => {
    const sql = releaseScopeSql();
    expect(sql).toContain(KEEP_RELEASE);
    expect(sql.indexOf("dbo.NewsReleaseDocumentContact")).toBeLessThan(sql.indexOf("DELETE d FROM dbo.NewsReleaseDocument"));
    expect(sql.indexOf("UPDATE dbo.Ministry SET TopReleaseId")).toBeLessThan(sql.indexOf("DELETE r FROM dbo.NewsRelease"));
    expect(sql).toContain("HomeTopReleaseId");
    expect(sql).toContain("c.PublishDateTime > @refUtc");
  });

  it("keeps only ended, non-confidential activities and clears what pointed at the rest", () => {
    const sql = activityScopeSql();
    expect(KEEP_ACTIVITY).toBe("a.EndDateTime < @refWall AND a.IsConfidential = 0");
    for (const t of ACTIVITY_CHILD_TABLES) expect(sql).toContain(`DELETE x FROM ${t} x`);
    expect(sql).toContain("SET ActivityId = NULL");
    expect(sql.lastIndexOf("DELETE a FROM calendar.Activity")).toBeGreaterThan(sql.indexOf("calendar.Log"));
  });

  it("requires every table it touches", () => {
    for (const t of [...ACTIVITY_CHILD_TABLES, ...EMPTIED_TABLES, ...STRUCTURED.map((s) => s.table)]) expect(REQUIRED_TABLES).toContain(t);
  });

  it("quotes names and refuses anything else", () => {
    expect(quoteName("dbo.User")).toBe("[dbo].[User]");
    expect(quoteCol("Key")).toBe("[Key]");
    expect(() => quoteName("dbo.User; DROP TABLE x")).toThrow();
    expect(() => quoteCol("a]b")).toThrow();
  });
});

import type { CsvFile } from "../src/import/csv-snapshot";

/** A fictional cutoff for the CSV fixture: every activity below ends on or after it. */
export const CSV_CUTOFF = "2031-03-01";
/** Fictional legacy GUIDs, uppercase as legacy stores them. */
export const CSV_GUID = {
  fin: "0E000000-0000-4000-8000-000000000001",
  hq: "0E000000-0000-4000-8000-000000000002",
  engage: "0E000000-0000-4000-8000-000000000003",
  sector: "0E000000-0000-4000-8000-000000000004",
  theme: "0E000000-0000-4000-8000-000000000005",
  tag: "0E000000-0000-4000-8000-000000000006",
  rel1: "0E000000-0000-4000-8000-0000000000A1",
  rel2: "0E000000-0000-4000-8000-0000000000A2",
  rel3: "0E000000-0000-4000-8000-0000000000A3",
} as const;

/** Windows-1252 bytes: Latin-1 for U+00A0–U+00FF, plus the curly apostrophe at 0x92. */
export function cp1252(text: string): Uint8Array {
  return Uint8Array.from([...text].map((ch) => {
    const c = ch.codePointAt(0)!;
    if (ch === "’") return 0x92;
    if (c < 0x80 || (c >= 0xa0 && c <= 0xff)) return c;
    throw new Error(`no Windows-1252 byte for U+${c.toString(16)}`);
  }));
}
const q = (v: string) => (/[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
const line = (cells: (string | number)[]) => cells.map((c) => q(String(c))).join(",");
const pad = (cells: (string | number)[], width: number) => [...cells, ...Array(width - cells.length).fill("")];
const csv = (records: (string | number)[][]) => `${records.map(line).join("\r\n")}\r\n`;

export const ACTIVITY_COLUMNS = [
  "query", "Id", "StartDateTime", "EndDateTime", "PotentialDates", "NRDateTime", "IsAllDay", "IsConfirmed",
  "Title", "Details", "Schedule", "Significance", "Strategy", "Comments", "HqComments",
  "LeadOrganization", "Venue", "Translations", "OtherCity",
  "StatusId", "HqStatusId", "HqSection", "NRDistributionId", "PremierRequestedId",
  "ContactMinistryId", "GovernmentRepresentativeId", "CommunicationContactId", "EventPlannerId",
  "VideographerId", "CityId",
  "IsActive", "IsIssue", "IsAtLegislature", "IsConfidential", "IsCrossGovernment", "IsMilestone",
  "CreatedDateTime", "CreatedBy", "LastUpdatedDateTime", "LastUpdatedBy",
] as const;
type ActivityCells = Partial<Record<(typeof ACTIVITY_COLUMNS)[number], string | number>>;
function activity(Id: number, over: ActivityCells): (string | number)[] {
  const base: ActivityCells = {
    query: "8.10", Id, PotentialDates: "", NRDateTime: "NULL", IsAllDay: 0, IsConfirmed: 1,
    Title: `Sample activity ${Id}`, Details: "Sample details", Schedule: "Sample schedule", Significance: "Sample significance",
    Strategy: "", Comments: "", HqComments: "Sample summary", LeadOrganization: "", Venue: "", Translations: "NULL", OtherCity: "",
    StatusId: 2, HqStatusId: "NULL", HqSection: 1, NRDistributionId: "NULL", PremierRequestedId: "NULL",
    ContactMinistryId: CSV_GUID.fin, GovernmentRepresentativeId: "NULL", CommunicationContactId: 501, EventPlannerId: "NULL",
    VideographerId: "NULL", CityId: 311,
    IsActive: 1, IsIssue: 0, IsAtLegislature: 0, IsConfidential: 0, IsCrossGovernment: 0, IsMilestone: 0,
    CreatedDateTime: "2031-01-10T09:00:00.000", CreatedBy: 9100, LastUpdatedDateTime: "2031-02-01T09:00:00.000", LastUpdatedBy: 9100,
  };
  const row = { ...base, ...over };
  return ACTIVITY_COLUMNS.map((c) => row[c] ?? "");
}

/** Five activities in March 2031: a plain one, an awareness date, a deleted one, an issue, and one spanning the cutoff. */
export function activitiesCsv(): string {
  return csv([
    [...ACTIVITY_COLUMNS],
    activity(41001, {
      StartDateTime: "2031-03-03T09:00:00.000", EndDateTime: "2031-03-03T10:00:00.000",
      Title: "Sample café opening", Details: "Sample details, with a comma, a \"quote\" and the minister’s line\r\nand a second line",
    }),
    activity(41002, { StartDateTime: "2031-03-04T00:00:00.000", EndDateTime: "2031-03-04T23:59:00.000", IsAllDay: 1, HqSection: 4, Title: "Sample awareness day" }),
    activity(41003, { StartDateTime: "2031-03-03T13:00:00.000", EndDateTime: "2031-03-03T14:00:00.000", IsActive: 0, Title: "Sample deleted activity" }),
    activity(41004, {
      StartDateTime: "2031-03-05T09:00:00.000", EndDateTime: "2031-03-05T10:00:00.000", IsIssue: 1, HqSection: 2,
      ContactMinistryId: CSV_GUID.hq, CommunicationContactId: 502, NRDateTime: "2031-03-05T08:30:00.000", Title: "Sample issue",
    }),
    activity(41005, { StartDateTime: "2031-02-27T09:00:00.000", EndDateTime: "2031-03-03T17:00:00.000", HqSection: -1, Title: "Sample spanning activity" }),
  ]);
}

/** 8.11–8.19 in one file, separated as SSMS separates result sets; 8.16 has no rows, so no section. */
export function joinsCsv(): string {
  const sep = ["", "", "", ""];
  return csv([
    ["query", "ActivityId", "CategoryId", "IsActive"], ["8.11", 41001, 12, 1], ["8.11", 41002, 2, 1], ["8.11", 41003, 12, 1], ["8.11", 41004, 12, 1], ["8.11", 41005, 12, 1], sep, sep,
    ["query", "ActivityId", "CommunicationMaterialId", "IsActive"], ["8.12", 41001, 1, 1], sep, sep,
    ["query", "ActivityId", "InitiativeId", "IsActive"], ["8.13", 41004, 1, 1], sep, sep,
    ["query", "ActivityId", "KeywordId", "IsActive"], ["8.14", 41001, 1, 1], sep, sep,
    ["query", "ActivityId", "NROriginId", "IsActive"], ["8.15", 41001, 1, 1], sep, sep,
    ["query", "ActivityId", "MinistryId", "IsActive"], ["8.17", 41004, CSV_GUID.fin, 1], sep, sep,
    ["query", "ActivityId", "TagId", "IsActive"], ["8.18", 41004, CSV_GUID.tag, 1], sep, sep,
    ["query", "ActivityId", "ThemeId", "IsActive"], ["8.19", 41004, CSV_GUID.theme, 1],
  ]);
}

/** 8.20, labelled "8.2" as the real export has it. */
export function releasesCsv(): string {
  const rel = (id: string, activityId: number, key: string) => ["8.2", id, activityId, key, 1, "2031-03-03T10:00:00-07:00", 1, 1];
  return csv([
    ["query", "Id", "ActivityId", "Key", "ReleaseType", "PublishDateTime", "IsPublished", "IsActive"],
    rel(CSV_GUID.rel1, 41001, "2031FIN0001-000001"), rel(CSV_GUID.rel2, 41001, "2031FIN0002-000002"), rel(CSV_GUID.rel3, 41004, "2031HQ0001-000003"),
  ]);
}

/** 8.30–8.46 in one file, every record padded to 10 columns as the real export is. */
export function lookupsCsv(): string {
  const W = 10;
  const sep = pad([], W);
  const section = (header: string[], rows: (string | number)[][]) => [pad(header, W), ...rows.map((r) => pad(r, W)), sep, sep];
  return csv([
    ...section(["query", "Id", "Name", "SortOrder", "IsActive", "TimeStamp", "RowGuid"], [["8.30", 2, "Sample awareness", 1, 1, "0x01", CSV_GUID.rel1], ["8.30", 12, "Sample category", 2, 1, "0x02", CSV_GUID.rel2]]),
    ...section(["query", "Id", "Name", "IsActive", "TimeStamp", "RowGuid", "SortOrder"], [["8.31", 311, "Sample City", 1, "0x03", "NULL", 1]]),
    ...section(["query", "Id", "SystemUserId", "Name", "MinistryShortName", "MinistryId", "SortOrder", "IsActive", "TimeStamp", "RowGuid"], [
      ["8.32", 501, 9001, "Sample Contact One", "SFIN", CSV_GUID.fin, 1, 1, "0x04", "NULL"],
      ["8.32", 502, 9002, "Sample Contact Two", "SHQ", CSV_GUID.hq, 2, 0, "0x05", "NULL"],
      ["8.32", 503, 9001, "Sample Contact Alias", "SHQ", CSV_GUID.hq, 1, 1, "0x06", "NULL"],
      ["8.32", 504, 9003, "Sample No Ministry", "", "NULL", "NULL", 1, "0x07", "NULL"],
    ]),
    ...section(["query", "Id", "Name", "IsActive", "SortOrder", "TimeStamp", "RowGuid"], [["8.33", 1, "Sample material", 1, 1, "0x08", CSV_GUID.rel3]]),
    ...section(["query", "Id", "Name", "PhoneNumber", "JobTitle", "SortOrder", "IsActive", "TimeStamp", "RowGuid"], [["8.34", 1, "Sample Planner", "NULL", "Sample planner title", 1, 1, "0x09", "NULL"]]),
    ...section(["query", "Id", "Name", "Description", "IsActive", "SortOrder", "TimeStamp", "RowGuid"], [["8.35", 1, "Sample Representative", "Sample description", 1, "NULL", "0x0A", "NULL"]]),
    ...section(["query", "Id", "Name", "IsActive", "SortOrder", "TimeStamp", "RowGuid", "ShortName"], [["8.36", 1, "Sample initiative", 1, 1, "0x0B", CSV_GUID.rel1, "SI"]]),
    ...section(["query", "Id", "Name", "SortOrder", "IsActive", "LastUpdatedDateTime", "LastUpdatedBy"], [["8.37", 1, "Sample keyword", 0, 1, "2031-01-01T00:00:00.000", 9100]]),
    ...section(["query", "Id", "Name", "SortOrder", "IsActive", "TimeStamp", "RowGuid"], [["8.38", 1, "Sample distribution", 1, 1, "0x0C", CSV_GUID.rel2]]),
    ...section(["query", "Id", "Name", "IsActive", "SortOrder", "TimeStamp", "RowGuid"], [["8.39", 1, "Sample origin", 1, "NULL", "0x0D", CSV_GUID.rel3]]),
    ...section(["query", "Id", "Name", "IsActive", "SortOrder", "TimeStamp", "RowGuid"], [["8.40", 1, "Sample request", 1, 1, "0x0E", CSV_GUID.rel1]]),
    // The curly apostrophe forces this file's bytes to be invalid UTF-8, so decodeCsv falls back to
    // Windows-1252 for the whole file -- this section is ignored (not in SECTION_COLUMNS), so the
    // character never reaches a parsed field.
    ...section(["query", "Id", "Name", "IsActive", "TimeStamp", "RowGuid"], [["8.41", 1, "Sample status’", 1, "0x0F", CSV_GUID.rel2]]),
    ...section(["query", "Id", "Name", "JobTitle", "SortOrder", "IsActive", "TimeStamp", "RowGuid"], [["8.42", 1, "Sample Videographer", "NULL", 1, 1, "0x10", "NULL"]]),
    ...section(["query", "Id", "Key", "DisplayName", "Abbreviation", "IsActive"], [
      ["8.43", CSV_GUID.fin, "sample-finance", "Sample Finance", "SFIN", 1],
      ["8.43", CSV_GUID.hq, "sample-hq", "Sample Communications HQ", "GCPEHQ", 1],
      ["8.43", CSV_GUID.engage, "sample-engagement", "Sample Engagement", "CITENG", 1],
    ]),
    ...section(["query", "Id", "Key", "DisplayName", "IsActive"], [["8.44", CSV_GUID.sector, "sample-sector", "Sample sector", 1]]),
    ...section(["query", "Id", "Key", "DisplayName", "IsActive"], [["8.45", CSV_GUID.theme, "sample-theme", "Sample theme", 1]]),
    ...[pad(["query", "Id", "Key", "DisplayName", "SortOrder", "IsActive"], W), pad(["8.46", CSV_GUID.tag, "sample-tag", "Sample tag", 0, 1], W)],
  ]);
}

export function partCCsv(): string {
  return csv([["query", "rows_returned"], ["8.10", 5], ["8.11", 5], ["8.12", 1], ["8.13", 1], ["8.14", 1], ["8.15", 1], ["8.16", 0], ["8.17", 1], ["8.18", 1], ["8.19", 1], ["8.2", 3], ["8.46", 1]]);
}

const utf8 = (s: string) => new TextEncoder().encode(s);
/** The four files as the real export has them: two Windows-1252, two UTF-8. */
export function legacyCsvFiles(): CsvFile[] {
  return [
    { name: "activities.csv", bytes: cp1252(activitiesCsv()) },
    { name: "joins.csv", bytes: utf8(joinsCsv()) },
    { name: "releases.csv", bytes: utf8(releasesCsv()) },
    { name: "lookups.csv", bytes: cp1252(lookupsCsv()) },
  ];
}
export const partCFile = (): CsvFile => ({ name: "part-c.csv", bytes: utf8(partCCsv()) });

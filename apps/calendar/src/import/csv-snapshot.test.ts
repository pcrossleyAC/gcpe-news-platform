import { describe, expect, it } from "vitest";
import { TEST_RULES } from "../../test/helpers";
import { CSV_CUTOFF, CSV_GUID, legacyCsvFiles, partCFile, partCCsv } from "../../test/legacy-csv-fixture";
import { CsvSnapshotError, decodeCsv, parseCsv, sectionLabel, snapshotFromCsv, type CsvFile, type LegacyKeyRows } from "./csv-snapshot";
import { joinsByActivity, mapActivity, unknownLegacyKeys } from "./map";
import { selectScope } from "./scope";

const utf8 = (s: string) => new TextEncoder().encode(s);
const read = (o: { partC?: CsvFile | undefined; users?: boolean; files?: CsvFile[] } = {}) =>
  snapshotFromCsv(o.files ?? legacyCsvFiles(), { partC: "partC" in o ? o.partC : partCFile(), usersFromCommContacts: o.users ?? true });

describe("decodeCsv", () => {
  it("reads Windows-1252 when the bytes aren't UTF-8, and UTF-8 without its BOM otherwise", () => {
    expect(decodeCsv(Uint8Array.from([0x63, 0x61, 0x66, 0xe9, 0x92]))).toEqual({ text: "café’", encoding: "windows-1252" });
    expect(decodeCsv(Uint8Array.from([0xef, 0xbb, 0xbf, 0x63, 0xc3, 0xa9]))).toEqual({ text: "cé", encoding: "utf-8" });
  });
});

describe("parseCsv", () => {
  it("keeps quoted commas, quotes and line breaks in one field", () => {
    expect(parseCsv('a,"b, ""c""\r\nd",e\r\nf,,\r\n')).toEqual([["a", 'b, "c"\r\nd', "e"], ["f", "", ""]]);
  });
  it("refuses a quoted field that never closes", () => {
    expect(() => parseCsv('a,"b\r\n')).toThrow(CsvSnapshotError);
  });
});

describe("sectionLabel", () => {
  it("reads labels as numbers, to two decimals", () => {
    expect(["8.2", "8.10", "8.46", " 8.11 ", "query", "x", ""].map(sectionLabel)).toEqual(["8.20", "8.10", "8.46", "8.11", null, null, null]);
  });
});

describe("snapshotFromCsv", () => {
  it("builds the importer's snapshot from the four files", () => {
    const { snapshot: s, encodings, ignoredSections, keys } = read();
    expect(encodings).toEqual({ "activities.csv": "windows-1252", "joins.csv": "utf-8", "releases.csv": "utf-8", "lookups.csv": "windows-1252" });
    expect(ignoredSections).toEqual(["8.41"]);
    expect(s.activities.map((a) => a.Id)).toEqual([41001, 41002, 41003, 41004, 41005]);
    const a = s.activities[0]!;
    expect(a.Title).toBe("Sample café opening");
    expect(a.Details).toBe("Sample details, with a comma, a \"quote\" and the minister’s line\r\nand a second line");
    expect(a.StartDateTime).toEqual(new Date(Date.UTC(2031, 2, 3, 9, 0)));
    expect(a.NRDateTime).toBeNull();
    expect(a.Translations).toBeNull();
    expect(a.PotentialDates).toBe("");
    expect(a.IsActive).toBe(true);
    expect(a.IsTitleNeedsReview).toBe(false);
    expect(s.activities[2]!.IsActive).toBe(false);
    expect(s.activities[4]!.HqSection).toBe(-1);
    expect(s.joins.categories).toHaveLength(5);
    expect(s.joins.sectors).toEqual([]);
    expect(s.joins.tags).toEqual([{ ActivityId: 41004, ValueId: CSV_GUID.tag, IsActive: true }]);
    expect(s.joins.categories[1]).toEqual({ ActivityId: 41002, ValueId: 2, IsActive: true });
    expect(s.releaseLinks).toEqual([{ ActivityId: 41001, N: 2 }, { ActivityId: 41004, N: 1 }]);
    expect(s.lookups.cities).toEqual([{ Id: 311, Name: "Sample City", SortOrder: 1, IsActive: true }]);
    expect(s.lookups.eventPlanners[0]).toMatchObject({ PhoneNumber: null, JobTitle: "Sample planner title" });
    expect(s.lookups.initiatives[0]).toMatchObject({ ShortName: "SI" });
    expect(s.commContacts).toEqual([
      { Id: 501, SystemUserId: 9001, MinistryId: CSV_GUID.fin, SortOrder: 1, IsActive: true },
      { Id: 502, SystemUserId: 9002, MinistryId: CSV_GUID.hq, SortOrder: 2, IsActive: false },
      { Id: 503, SystemUserId: 9001, MinistryId: CSV_GUID.hq, SortOrder: 1, IsActive: true },
      { Id: 504, SystemUserId: 9003, MinistryId: null, SortOrder: null, IsActive: true },
    ]);
    expect(s.totals).toEqual({ activities: 5, favourites: 0, files: 0, logs: 0 });
    expect([s.userMinistries, s.savedFilters, s.favourites, s.files, s.logs]).toEqual([[], [], [], [], []]);
    expect(keys.ministries.map((m) => [m.Key, m.Abbreviation])).toEqual([["sample-finance", "SFIN"], ["sample-hq", "GCPEHQ"], ["sample-engagement", "CITENG"]]);
    expect(keys.tags[0]).toMatchObject({ Id: CSV_GUID.tag, Key: "sample-tag", SortOrder: 0, IsActive: true });
  });

  it("makes one inactive, email-less, role-less user per comm contact user, named from a contact the activities use", () => {
    const { snapshot: s } = read();
    expect(s.users.map((u) => [u.Id, u.DisplayName, u.EmailAddress, u.IsActive, u.RoleId])).toEqual([
      [9001, "Sample Contact One", null, false, 0],
      [9002, "Sample Contact Two", null, false, 0],
      [9003, "Sample No Ministry", null, false, 0],
    ]);
    expect(s.provenance).toEqual({
      notProvided: ["userMinistries", "savedFilters", "favourites", "files", "logs"],
      usersFromCommContacts: true,
      notes: [
        "needs-review flags aren't in the export: imported as none",
        "users are made from comm contacts: names only, no email, no role, inactive",
      ],
    });
  });

  it("leaves users empty and not provided when asked to", () => {
    const { snapshot: s } = read({ users: false });
    expect(s.users).toEqual([]);
    expect(s.provenance?.notProvided).toEqual(["users", "userMinistries", "savedFilters", "favourites", "files", "logs"]);
  });

  it("refuses a missing section unless Part C says it is empty", () => {
    expect(() => read({ partC: undefined })).toThrow(/section 8\.16 is missing/);
    expect(read().snapshot.joins.sectors).toEqual([]);
  });

  it("refuses a section whose row count isn't Part C's", () => {
    const partC: CsvFile = { name: "part-c.csv", bytes: utf8(partCCsv().replace("8.12,1", "8.12,2")) };
    expect(() => read({ partC })).toThrow("section 8.12: 1 rows read, Part C says 2");
  });

  it("refuses a section in two files", () => {
    const files = legacyCsvFiles();
    expect(() => read({ files: [...files, { ...files[1]!, name: "joins-again.csv" }] })).toThrow(/section 8\.11 appears twice \(joins\.csv and joins-again\.csv\)/);
  });

  it("refuses a section whose header lacks its columns (survey 08's Part A file)", () => {
    const partA: CsvFile = { name: "part-a.csv", bytes: utf8("query,CategoryId,Name,Active\r\n8.1,2,Sample,1\r\n") };
    expect(() => read({ files: [...legacyCsvFiles(), partA] })).toThrow("part-a.csv: section 8.10's header lacks Id");
  });

  it("errors name the place, never the value", () => {
    const files = legacyCsvFiles();
    const bad = new TextDecoder("windows-1252").decode(files[0]!.bytes).replace("2031-03-04T00:00:00.000", "2031-02-30T00:00:00.000");
    const run = () => read({ files: [{ name: "activities.csv", bytes: new TextEncoder().encode(bad) }, ...files.slice(1)] });
    expect(run).toThrow("activities.csv: section 8.10, row 2, column StartDateTime: not a date and time");
    try { run(); } catch (e) { expect((e as Error).message).not.toContain("2031-02-30"); }
  });

  it("feeds the importer's scope and mapping: every activity in scope, every key known", () => {
    const { snapshot: s, keys } = read();
    const scope = selectScope(s, { cutoff: CSV_CUTOFF, awarenessCategoryIds: TEST_RULES.awarenessCategoryIds });
    expect(scope.activities).toHaveLength(5);
    const known = legacyKeysOf(keys);
    expect(unknownLegacyKeys(s, scope, known)).toEqual([]);
    const joins = joinsByActivity(scope);
    const mapped = scope.activities.map((a) => mapActivity(a, joins.get(a.Id)!, { timeZone: TEST_RULES.timeZone, userIdOf: () => null, commContactIdOf: (id) => id, keys: known }));
    expect(mapped.filter((m) => "skip" in m)).toEqual([]);
  });
});

/** Core's view of the fixture's keys, without a database: legacy GUIDs lowercased, as Core stores them. */
function legacyKeysOf(k: LegacyKeyRows) {
  const orgs = new Map(k.ministries.map((m) => [m.Id.toLowerCase(), { id: m.Id.toLowerCase(), key: m.Key, displayName: m.DisplayName, abbreviation: m.Abbreviation }]));
  const terms = new Map([...k.sectors.map((t) => [`sector:${t.Id.toLowerCase()}`, t.Key]), ...k.themes.map((t) => [`theme:${t.Id.toLowerCase()}`, t.Key]), ...k.tags.map((t) => [`tag:${t.Id.toLowerCase()}`, t.Key])] as [string, string][]);
  return { org: (g: string) => orgs.get(g.trim().toLowerCase()) ?? null, termKey: (kind: "sector" | "theme" | "tag", g: string) => terms.get(`${kind}:${g.trim().toLowerCase()}`) ?? null };
}

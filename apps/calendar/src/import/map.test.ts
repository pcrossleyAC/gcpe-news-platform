import { describe, expect, it } from "vitest";
import { createFakeSource, wallClockToInstant } from "@gcpe/legacy-import";
import type { LegacyKeys } from "../../../core/src/import/legacy-keys";
import { GUID, legacyCalendarTables, TEST_CUTOFF } from "../../test/legacy-calendar-fixture";
import { TEST_RULES } from "../../test/helpers";
import { loadLegacy } from "./load";
import { hqSectionOf, joinsByActivity, mapActivity, mapLookup, unknownLegacyKeys, userCandidates, validationProblems, type MappedActivity } from "./map";
import { selectScope } from "./scope";

const ORGS: Record<string, { id: string; key: string; displayName: string; abbreviation: string }> = {
  [GUID.fin.toLowerCase()]: { id: "00000000-0000-4000-8000-0000000000f1", key: "finance", displayName: "Sample Finance", abbreviation: "FIN" },
  [GUID.hlth.toLowerCase()]: { id: "00000000-0000-4000-8000-0000000000f2", key: "health", displayName: "Sample Health", abbreviation: "HLTH" },
  [GUID.hq.toLowerCase()]: { id: "00000000-0000-4000-8000-0000000000f3", key: "gcpehq", displayName: "Sample HQ", abbreviation: "GCPEHQ" },
};
const TERMS: Record<string, string> = { [`sector:${GUID.sector.toLowerCase()}`]: "sample-sector", [`theme:${GUID.theme.toLowerCase()}`]: "sample-theme", [`tag:${GUID.tag.toLowerCase()}`]: "sample-tag" };
const keys: LegacyKeys = { org: (g) => ORGS[g.toLowerCase()] ?? null, termKey: (k, g) => TERMS[`${k}:${g.toLowerCase()}`] ?? null };
const opts = { cutoff: TEST_CUTOFF, awarenessCategoryIds: [2] };
const TZ = "America/Vancouver";
const uid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const ctx = { timeZone: TZ, userIdOf: (id: number | null) => (id === null ? null : uid(id)), commContactIdOf: (id: number | null) => (id === 504 ? 503 : id), keys };

async function mapped() {
  const s = await loadLegacy(createFakeSource(legacyCalendarTables()), opts);
  const scope = selectScope(s, opts);
  const joins = joinsByActivity(scope);
  return { s, scope, all: scope.activities.map((a) => mapActivity(a, joins.get(a.Id)!, ctx)) };
}
const one = async (id: number) => (await mapped()).all.find((m) => m.id === id) as MappedActivity;

describe("activity mapping", () => {
  it("maps statuses, the section, flags, translations, keys, joins and times by legacy's rules", async () => {
    const m = await one(1001);
    expect(m.values).toMatchObject({
      status: "new", hqSection: "events_and_speeches", longTermOutlook: false, cityId: 311, otherCity: "Sample Bay",
      translations: ["French", "Punjabi"], needsReview: ["digital", "title"], contactMinistryKey: "finance",
      commContactId: 501, createdBy: uid(11), lastUpdatedBy: uid(12), deletedAt: null,
    });
    expect(m.values.startAt).toEqual(wallClockToInstant(new Date("2027-01-20T09:00:00Z"), TZ));
    expect(m.joins).toMatchObject({ categoryIds: [12, 58], keywordIds: [40, 41], sectorKeys: ["sample-sector"], themeKeys: ["sample-theme"], tagKeys: ["sample-tag"] });
  });

  it("maps every HqSection from −4 to 4, negatives with Long Term Outlook, 0 to Not on LA with a note", async () => {
    expect([1, 2, 3, 4].map((n) => hqSectionOf(n)?.hqSection)).toEqual(["issues_and_reports", "events_and_speeches", "in_the_news", "not_on_la"]);
    expect(hqSectionOf(-4)).toEqual({ hqSection: "not_on_la", longTermOutlook: true });
    expect(hqSectionOf(0)).toBeNull();
    const m = await one(1012);
    expect(m.values).toMatchObject({ hqSection: "not_on_la", longTermOutlook: false, hqStatus: "new" });
    expect(m.notes).toContain("HqSection 0 is not a legacy section; imported as Not on LA");
  });

  it("nulls and NULs: a null status and created time get fixed fallbacks, NUL characters are stripped", async () => {
    const m = await one(1012);
    expect(m.values.status).toBe("new");
    expect(m.values.createdAt).toEqual(m.values.lastUpdatedAt);
    expect(m.values.details).toBe("Sampledetails");
    expect(mapLookup("categories", { Id: 91, Name: null, SortOrder: null, IsActive: null })).toEqual({ id: 91, name: "", sortOrder: 0, isActive: false });
    expect(mapLookup("keywords", { Id: 40, Name: "3-10", SortOrder: 40, IsActive: true }).name).toBe("3-10");
  });

  it("a deleted activity takes its deletion from the last update; a confidential one keeps its section and flags", async () => {
    expect((await one(1005)).values).toMatchObject({ deletedBy: uid(12) });
    expect((await one(1005)).values.deletedAt).toEqual(wallClockToInstant(new Date("2026-09-02T10:00:00Z"), TZ));
    const c = await one(1011);
    expect(c.values).toMatchObject({ isConfidential: true, hqSection: "not_on_la", longTermOutlook: true, status: "changed", hqStatus: "changed" });
    expect(c.values.title).toHaveLength(217);
    expect(c.joins.sharedWithKeys).toEqual(["health"]);
  });

  it("remaps a merged comm contact, and keeps an activity with none", async () => {
    expect((await one(1004)).values.commContactId).toBe(503);
    expect((await one(1009)).values.commContactId).toBeNull();
  });

  it("rejects a year outside 1900–2199 instead of importing it", async () => {
    expect((await mapped()).all.find((m) => m.id === 1013)).toEqual({ id: 1013, skip: "a date's year is outside 1900–2199" });
  });

  it("lists the fields the shared validation refuses on every save, by name only", async () => {
    const m = await one(1009); // no end, no comm contact
    expect(validationProblems(m, [], TEST_RULES)).toEqual(expect.arrayContaining(["commContactId", "endDate"]));
  });
});

describe("users and keys", () => {
  it("builds a Core candidate per selected user, with legacy's role and active ministries", async () => {
    const { s, scope } = await mapped();
    const c = userCandidates(s, scope, keys);
    expect(c.map((u) => u.legacyId)).toEqual([11, 12, 13, 14, 16, 19, 20, 21, 22]);
    expect(c.find((u) => u.legacyId === 12)).toMatchObject({ calendarRole: "Calendar.SysAdmin", organizationIds: [ORGS[GUID.hq.toLowerCase()]!.id], isActive: true });
    expect(c.find((u) => u.legacyId === 16)).toMatchObject({ email: null, isActive: false, calendarRole: "Calendar.ReadOnly" });
  });

  it("lists every unknown GUID the in-scope data uses, and none an out-of-scope user holds", async () => {
    const t = legacyCalendarTables();
    (t.activitySharedWith as object[]).push({ ActivityId: 1001, ValueId: GUID.unknown, IsActive: true });
    const s = await loadLegacy(createFakeSource(t), opts);
    expect(unknownLegacyKeys(s, selectScope(s, opts), keys)).toEqual([{ kind: "ministry", guid: GUID.unknown.toLowerCase() }]);
    const clean = await loadLegacy(createFakeSource(legacyCalendarTables()), opts);
    expect(unknownLegacyKeys(clean, selectScope(clean, opts), keys)).toEqual([]);
  });
});

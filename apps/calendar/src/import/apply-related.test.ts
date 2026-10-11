import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { createFakeSource } from "@gcpe/legacy-import";
import { downloadContentType, localStore, type ObjectStore } from "@gcpe/storage";
import type { TestDatabase } from "@gcpe/db-kit";
import type { LegacyKeys } from "../../../core/src/import/legacy-keys";
import { createCalendarTestDb } from "../../test/helpers";
import { GUID, legacyCalendarTables, PDF_BYTES, TEST_CUTOFF } from "../../test/legacy-calendar-fixture";
import { activityChanges, activityFiles, favourites, savedFilters, userProfiles } from "../db/schema";
import { applyFavourites, applyFiles, applyHistory, applyProfiles, applySavedFilters } from "./apply-related";
import { applyActivities, applyCommContacts, applyLookups, rebaseSequences } from "./apply";
import type { HistoryContext } from "./history-map";
import { mapHistory } from "./history-map";
import { loadLegacy } from "./load";
import { joinsByActivity, mapActivity, type MappedActivity } from "./map";
import { CalendarImportReport } from "./report";
import { selectScope } from "./scope";

// The same in-memory keys as map.test.ts.
const ORGS: Record<string, { id: string; key: string; displayName: string; abbreviation: string }> = {
  [GUID.fin.toLowerCase()]: { id: "00000000-0000-4000-8000-0000000000f1", key: "finance", displayName: "Sample Finance", abbreviation: "FIN" },
  [GUID.hlth.toLowerCase()]: { id: "00000000-0000-4000-8000-0000000000f2", key: "health", displayName: "Sample Health", abbreviation: "HLTH" },
  [GUID.hq.toLowerCase()]: { id: "00000000-0000-4000-8000-0000000000f3", key: "gcpehq", displayName: "Sample HQ", abbreviation: "GCPEHQ" },
};
const TERMS: Record<string, string> = { [`sector:${GUID.sector.toLowerCase()}`]: "sample-sector", [`theme:${GUID.theme.toLowerCase()}`]: "sample-theme", [`tag:${GUID.tag.toLowerCase()}`]: "sample-tag" };
const keys: LegacyKeys = { org: (g) => ORGS[g.toLowerCase()] ?? null, termKey: (k, g) => TERMS[`${k}:${g.toLowerCase()}`] ?? null } as LegacyKeys;
const uid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
/** Legacy users 13 and 14 share an email, so Core gives them one user, as the Core user import does. */
const userOf = (n: number) => uid(n === 14 ? 13 : n);
const opts = { cutoff: TEST_CUTOFF, awarenessCategoryIds: [2] };
let tdb: TestDatabase;
let store: ObjectStore;
beforeAll(async () => { tdb = await createCalendarTestDb(); });
afterAll(async () => { await tdb.drop(); });
beforeEach(async () => {
  await tdb.db.execute(sql`TRUNCATE activities, comm_contacts, categories, cities, comm_materials, event_planners, government_representatives, initiatives, keywords, nr_distributions, nr_origins, premier_requested, videographers, activity_changes, favourites, saved_filters, user_profiles, activity_files RESTART IDENTITY CASCADE`);
  store = localStore(await mkdtemp(join(tmpdir(), "cal-files-")));
});

async function importOnce(report = new CalendarImportReport("confirmed", TEST_CUTOFF)) {
  const s = await loadLegacy(createFakeSource(legacyCalendarTables()), opts);
  const scope = selectScope(s, opts);
  await applyLookups(tdb.db, s, report);
  const remap = await applyCommContacts(tdb.db, scope, userOf, keys, report);
  const joins = joinsByActivity(scope);
  const list = scope.activities.map((a) => mapActivity(a, joins.get(a.Id)!, { timeZone: "America/Vancouver", userIdOf: (id) => (id === null ? null : userOf(id)), commContactIdOf: (id) => (id === null ? null : (remap.get(id) ?? null)), keys }))
    .filter((m): m is MappedActivity => !("skip" in m));
  const result = await applyActivities(tdb.db, list, report);
  await rebaseSequences(tdb.db);
  return { s, scope, report, result };
}

/** The same shape as history-map.test.ts's context; run.ts's historyContextOf builds the real one. */
function historyContext(s: Awaited<ReturnType<typeof loadLegacy>>): HistoryContext {
  return {
    timeZone: "America/Vancouver",
    userIdOf: (id) => (id === null ? null : userOf(id)),
    actorNameOf: (id) => (id === null ? null : (s.users.find((u) => u.Id === id)?.DisplayName ?? null)),
    cityNameOf: (id) => s.lookups.cities.find((c) => c.Id === id)?.Name ?? null,
    commContactLabelOf: () => null,
    orgNameOf: (g) => keys.org(g)?.displayName ?? null,
    contactMinistryKeyOf: (activityId) => {
      const a = s.activities.find((x) => x.Id === activityId);
      return a?.ContactMinistryId ? (keys.org(a.ContactMinistryId)?.key ?? null) : null;
    },
  };
}

describe("favourites, profiles, saved filters, attachments and history", () => {
  it("favourites come with a newly inserted activity only, and never come back once removed", async () => {
    const { scope, result, report } = await importOnce();
    await applyFavourites(tdb.db, scope, userOf, result.inserted, report);
    expect(await tdb.db.select().from(favourites)).toEqual(expect.arrayContaining([{ userId: uid(11), activityId: 1001 }, { userId: uid(20), activityId: 1004 }]));
    await tdb.db.delete(favourites).where(eq(favourites.activityId, 1001));
    const again = await importOnce();
    await applyFavourites(tdb.db, again.scope, userOf, again.result.inserted, again.report);
    expect(await tdb.db.select().from(favourites)).toEqual([{ userId: uid(20), activityId: 1004 }]);
  });

  it("a profile per imported user, written once: list preferences together, an empty mobile kept, a bad one dropped", async () => {
    const { s, report } = await importOnce();
    await applyProfiles(tdb.db, s, [{ userId: uid(19), legacyIds: [19], representativeLegacyId: 19 }, { userId: uid(21), legacyIds: [21], representativeLegacyId: 21 }, { userId: uid(11), legacyIds: [11], representativeLegacyId: 11 }], report);
    expect((await tdb.db.select().from(userProfiles).where(eq(userProfiles.userId, uid(19))))[0]).toMatchObject({ listDisplay: "my_activities", hiddenColumns: ["keywords", "status"] });
    expect((await tdb.db.select().from(userProfiles).where(eq(userProfiles.userId, uid(11))))[0]!.mobile).toBe("");
    expect((await tdb.db.select().from(userProfiles).where(eq(userProfiles.userId, uid(21))))[0]!.mobile).toBeNull();
  });

  it("saved filters through the 5d converter, first time only; dropped values never reach the report", async () => {
    const { scope, report } = await importOnce();
    await applySavedFilters(tdb.db, scope, userOf, keys, report);
    expect((await tdb.db.select({ id: savedFilters.id }).from(savedFilters)).map((r) => r.id).sort()).toEqual([701, 702]);
    expect(report.toJSON().savedFilters.strippedPrefix).toBe(1);
    expect(JSON.stringify(report.toJSON())).not.toContain("sample typed text");
    await tdb.db.update(savedFilters).set({ name: "Renamed" }).where(eq(savedFilters.id, 701));
    await applySavedFilters(tdb.db, scope, userOf, keys, report);
    expect((await tdb.db.select().from(savedFilters).where(eq(savedFilters.id, 701)))[0]!.name).toBe("Renamed");
  });

  it("attachments: the bare name of a Windows path, a blocked type kept as legacy's and served as a download, a wrong MD5 skipped", async () => {
    const { scope, result, report } = await importOnce();
    await applyFiles(tdb.db, store, scope, userOf, result.present, "America/Vancouver", report);
    const rows = (await tdb.db.select().from(activityFiles)).sort((a, b) => a.id - b.id);
    expect(rows.map((r) => [r.id, r.fileName, r.contentType])).toEqual([[801, "briefing.pdf", "application/pdf"], [804, "notes.exe", "application/x-msdownload"]]);
    expect(downloadContentType(rows[1]!.contentType)).toBe("application/octet-stream");
    expect((await store.get(rows[0]!.storageKey))!.bytes.equals(PDF_BYTES)).toBe(true);
    expect(rows[0]!.storageKey).toMatch(/^activities\/1001\/[0-9a-f]{16}-briefing\.pdf$/);
    expect(report.toJSON().skipped).toContainEqual({ table: "files", legacyId: "802", reason: "MD5 doesn't match the bytes" });
  });

  it("history: legacy entries marked legacy_log, keyed so a re-run adds nothing", async () => {
    const { s, scope, result, report } = await importOnce();
    const h = mapHistory(scope.logs, historyContext(s)); // the same context run.ts builds
    await applyHistory(tdb.db, h.entries, h.skipped, result.present, report);
    await applyHistory(tdb.db, h.entries, h.skipped, result.present, report);
    const changes = await tdb.db.select().from(activityChanges);
    expect(changes).toHaveLength(3); // log:9001 (two fields), log:9005, log:9008
    expect(changes.every((c) => c.source === "legacy_log" && c.action === "updated")).toBe(true);
    expect(report.toJSON().tables.logRows).toMatchObject({ inserted: 4, unchanged: 4, skipped: 6 });
  });
});

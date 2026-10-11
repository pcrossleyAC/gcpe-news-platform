import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { createFakeSource } from "@gcpe/legacy-import";
import type { TestDatabase } from "@gcpe/db-kit";
import type { LegacyKeys } from "../../../core/src/import/legacy-keys";
import { createCalendarTestDb } from "../../test/helpers";
import { GUID, legacyCalendarTables, TEST_CUTOFF } from "../../test/legacy-calendar-fixture";
import { activities, categories, commContacts, keywords } from "../db/schema";
import { applyActivities, applyCommContacts, applyLookups, rebaseSequences } from "./apply";
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
beforeAll(async () => { tdb = await createCalendarTestDb(); });
afterAll(async () => { await tdb.drop(); });
beforeEach(async () => { await tdb.db.execute(sql`TRUNCATE activities, comm_contacts, categories, cities, comm_materials, event_planners, government_representatives, initiatives, keywords, nr_distributions, nr_origins, premier_requested, videographers RESTART IDENTITY CASCADE`); });

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

describe("writing the Calendar's own rows", () => {
  it("imports every lookup with its legacy id, a null name as empty, keyword names exactly", async () => {
    await importOnce();
    expect((await tdb.db.select().from(categories).where(eq(categories.id, 91)))[0]).toMatchObject({ name: "", isActive: false });
    expect((await tdb.db.select().from(categories).where(eq(categories.id, 16)))[0]!.name).toBe("Sample  speech");
    expect((await tdb.db.select().from(keywords).where(eq(keywords.id, 40)))[0]!.name).toBe("3-10");
  });

  it("merges two contacts of one person and ministry, skips one with no ministry, ranks by SortOrder", async () => {
    const { report } = await importOnce();
    expect((await tdb.db.select({ id: commContacts.id, rank: commContacts.rank }).from(commContacts)).sort((a, b) => a.id - b.id)).toEqual([{ id: 501, rank: 1 }, { id: 502, rank: 4 }, { id: 503, rank: 2 }]);
    expect(report.toJSON().skipped).toEqual(expect.arrayContaining([
      { table: "commContacts", legacyId: "504", reason: "merged into contact 503 (same person and ministry)" },
      { table: "commContacts", legacyId: "506", reason: "no ministry" },
    ]));
  });

  it("inserts activities with legacy ids and imported_version 1, and leaves them alone on a re-run", async () => {
    const { result } = await importOnce();
    expect([...result.inserted].sort()).toEqual([1001, 1002, 1004, 1005, 1006, 1009, 1010, 1011, 1012]);
    const again = await importOnce(new CalendarImportReport("confirmed", TEST_CUTOFF));
    expect(again.result.inserted.size).toBe(0);
    expect(again.report.toJSON().tables.activities).toMatchObject({ unchanged: 9, inserted: 0, updated: 0 });
  });

  it("skips an activity the Calendar changed since the import, and one created in the Calendar", async () => {
    await importOnce();
    await tdb.db.update(activities).set({ title: "Edited in the Calendar", version: 2 }).where(eq(activities.id, 1001));
    await tdb.db.update(activities).set({ importedVersion: null }).where(eq(activities.id, 1002));
    const { report } = await importOnce(new CalendarImportReport("confirmed", TEST_CUTOFF));
    expect((await tdb.db.select().from(activities).where(eq(activities.id, 1001)))[0]!.title).toBe("Edited in the Calendar");
    expect(report.toJSON().changedInCalendar).toEqual([1001, 1002]);
  });

  it("updates an unchanged-in-Calendar activity whose legacy values moved, bumping both versions", async () => {
    await importOnce();
    await tdb.db.update(activities).set({ title: "Stale import" }).where(eq(activities.id, 1002)); // as if legacy had changed
    const { report } = await importOnce(new CalendarImportReport("confirmed", TEST_CUTOFF));
    expect((await tdb.db.select().from(activities).where(eq(activities.id, 1002)))[0]).toMatchObject({ title: "Sample activity 1002", version: 2, importedVersion: 2 });
    expect(report.toJSON().tables.activities!.updated).toBe(1);
  });

  it("moves every legacy-id identity past the imported maximum", async () => {
    await importOnce();
    const [c] = await tdb.db.insert(categories).values({ name: "New after import" }).returning({ id: categories.id });
    expect(c!.id).toBeGreaterThan(91);
    const [a] = await tdb.db.insert(activities).values({}).returning({ id: activities.id });
    expect(a!.id).toBeGreaterThan(1012);
  });
});

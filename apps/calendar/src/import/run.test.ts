import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { asc, eq, sql } from "drizzle-orm";
import { inferLookAhead } from "@gcpe/calendar-contract";
import { createFakeSource } from "@gcpe/legacy-import";
import { localStore, type ObjectStore } from "@gcpe/storage";
import type { TestDatabase } from "@gcpe/db-kit";
import { createCoreTestDb } from "../../../core/test/helpers";
import { roleGrants, userLegacyIds, users as coreUsers } from "../../../core/src/db/schema";
import { createCalendarTestDb, TEST_RULES } from "../../test/helpers";
import { CONFIDENTIAL_MARKER, GUID, legacyCalendarTables, seedCoreForImport, TEST_CUTOFF } from "../../test/legacy-calendar-fixture";
import { legacyCsvFiles, partCFile, CSV_CUTOFF } from "../../test/legacy-csv-fixture";
import { snapshotFromCsv } from "./csv-snapshot";
import { seedCoreFromLegacyKeys } from "../../../../scripts/lib/calendar-parity-core";
import { activities, activityChanges, activityFiles, categories, commContacts as calCommContacts, favourites, savedFilters } from "../db/schema";
import { defaultReportPath, ImportStageError, parseImportArgs, runCalendarImport, runCalendarImportCli } from "./run";

let cal: TestDatabase, core: TestDatabase;
beforeAll(async () => { [cal, core] = await Promise.all([createCalendarTestDb(), createCoreTestDb()]); });
afterAll(async () => { await Promise.all([cal.drop(), core.drop()]); });
beforeEach(async () => {
  await cal.db.execute(sql`TRUNCATE activities, comm_contacts, saved_filters, user_profiles, favourites, activity_files, activity_changes, outbox_events, categories, cities, comm_materials, event_planners, government_representatives, initiatives, keywords, nr_distributions, nr_origins, premier_requested, videographers RESTART IDENTITY CASCADE`);
  await core.db.execute(sql`TRUNCATE users, organizations, terms, outbox_events, outbox_deliveries, aggregate_sequences CASCADE`);
  await seedCoreForImport(core.db);
});
const SUBS = [{ name: "calendar", url: "https://unused.example.test", secret: "unused-000000000000000000000000000000", types: ["user.upserted"] }];
async function deps(tables = legacyCalendarTables(), store?: ObjectStore) {
  const dir = await mkdtemp(join(tmpdir(), "cal-import-"));
  return { db: cal.db, coreDb: core.db, source: createFakeSource(tables), store: store ?? localStore(dir), rules: TEST_RULES, coreSubscribers: SUBS, storeDir: dir };
}
const confirm = { cutoff: TEST_CUTOFF, confirm: true };
const CAL_TABLES = ["activities", "activity_categories", "activity_keywords", "activity_shared_with", "comm_contacts", "favourites", "saved_filters", "user_profiles", "activity_files", "activity_changes", "activity_change_fields", "categories", "keywords"];
const CORE_TABLES = ["users", "role_grants", "user_organizations", "user_legacy_ids", "outbox_events"];
const snapshot = async () => {
  const out: Record<string, unknown> = {};
  for (const t of CAL_TABLES) out[`cal.${t}`] = (await cal.db.execute(sql.raw(`SELECT * FROM ${t} ORDER BY 1, 2`))).rows;
  for (const t of CORE_TABLES) out[`core.${t}`] = (await core.db.execute(sql.raw(`SELECT * FROM ${t} ORDER BY 1`))).rows;
  return out;
};

describe("calendar:import (acceptance 15)", () => {
  it("parses a required, real cutoff and --confirm", () => {
    expect(parseImportArgs(["--cutoff", "2027-01-15"])).toEqual({ cutoff: "2027-01-15", confirm: false });
    expect(parseImportArgs(["--cutoff", "2027-01-15", "--confirm", "--report", "r.json"])).toEqual({ cutoff: "2027-01-15", confirm: true, reportPath: "r.json" });
    expect(() => parseImportArgs([])).toThrow(/--cutoff/);
    expect(() => parseImportArgs(["--cutoff", "2027-02-30"])).toThrow();
    expect(() => parseImportArgs(["--cutoff", "2027-01-15", "--force"])).toThrow(/Unknown argument/);
  });

  it("a dry run writes nothing anywhere, and its report balances", async () => {
    const before = await snapshot();
    const d = await deps();
    const report = await runCalendarImport(d, { cutoff: TEST_CUTOFF, confirm: false });
    expect(await snapshot()).toEqual(before);
    expect(await readdir(d.storeDir)).toEqual([]);
    expect(report.toJSON()).toMatchObject({ mode: "dry-run", balanced: true });
    expect(report.toJSON().tables.activities).toMatchObject({ legacy: 14, outOfScope: 4, planned: 9, skipped: 1 });
  });

  it("imports exactly the in-scope activities with their legacy ids, and only their history, favourites and attachments", async () => {
    const report = await runCalendarImport(await deps(), confirm);
    expect((await cal.db.select({ id: activities.id }).from(activities).orderBy(asc(activities.id))).map((r) => r.id)).toEqual([1001, 1002, 1004, 1005, 1006, 1009, 1010, 1011, 1012]);
    expect([...new Set((await cal.db.select({ a: activityChanges.activityId }).from(activityChanges)).map((r) => r.a))].sort()).toEqual([1001, 1002]);
    expect((await cal.db.select().from(favourites)).map((f) => f.activityId).sort()).toEqual([1001, 1004]);
    expect((await cal.db.select({ id: activityFiles.id }).from(activityFiles)).map((r) => r.id).sort()).toEqual([801, 804]);
    expect(report.toJSON()).toMatchObject({ balanced: true, facts: expect.objectContaining({ releaseLinksOutOfScope: 2, releaseLinksInScope: 1 }) });
    expect(Number((await cal.db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM outbox_events`)).rows[0]!.n)).toBe(0);
  });

  it("imports only active or referenced users; no-email users are inactive and keep their activities", async () => {
    await runCalendarImport(await deps(), confirm);
    const legacy = (await core.db.select().from(userLegacyIds)).map((r) => Number(r.legacyId)).sort((a, b) => a - b);
    expect(legacy).toEqual([11, 12, 13, 14, 16, 19, 20, 21, 22]);
    const id16 = (await core.db.select().from(userLegacyIds).where(eq(userLegacyIds.legacyId, "16")))[0]!.userId;
    expect((await core.db.select().from(coreUsers).where(eq(coreUsers.id, id16)))[0]).toMatchObject({ email: null, isActive: false });
    expect((await cal.db.select().from(activities).where(eq(activities.id, 1009)))[0]!.createdBy).toBe(id16);
  });

  it("a re-run changes nothing: every table identical, nothing inserted or updated, no Core event", async () => {
    await runCalendarImport(await deps(), confirm);
    const before = await snapshot();
    const again = (await runCalendarImport(await deps(), confirm)).toJSON();
    expect(await snapshot()).toEqual(before);
    for (const c of Object.values(again.tables)) expect(c.inserted + c.updated).toBe(0);
    expect(again.balanced).toBe(true);
  });

  it("a re-run after Calendar edits reverts nothing, and lists the edited activity", async () => {
    await runCalendarImport(await deps(), confirm);
    await cal.db.update(activities).set({ title: "Edited in the Calendar", version: 2 }).where(eq(activities.id, 1001));
    await cal.db.delete(favourites).where(eq(favourites.activityId, 1001));
    await cal.db.update(savedFilters).set({ name: "Renamed" }).where(eq(savedFilters.id, 701));
    const report = (await runCalendarImport(await deps(), confirm)).toJSON();
    expect((await cal.db.select().from(activities).where(eq(activities.id, 1001)))[0]!.title).toBe("Edited in the Calendar");
    expect(await cal.db.select().from(favourites).where(eq(favourites.activityId, 1001))).toEqual([]);
    expect((await cal.db.select().from(savedFilters).where(eq(savedFilters.id, 701)))[0]!.name).toBe("Renamed");
    expect(report.changedInCalendar).toEqual([1001]);
  });

  it("the report holds no title, email or query text", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cal-report-"));
    const reportPath = join(dir, "r.json");
    expect(await runCalendarImportCli({ ...(await deps()), reportPath }, confirm)).toBe(0);
    for (const f of [reportPath, join(dir, "r.txt")]) {
      const text = await readFile(f, "utf8");
      for (const secret of [CONFIDENTIAL_MARKER, "example.test", "sample typed text", "Sample activity"]) expect(text).not.toContain(secret);
    }
  });

  it("an unknown legacy GUID stops the run before any write, naming it; exit 1 with a report", async () => {
    const t = legacyCalendarTables();
    (t.activitySharedWith as object[]).push({ ActivityId: 1001, ValueId: GUID.unknown, IsActive: true });
    const dir = await mkdtemp(join(tmpdir(), "cal-report-"));
    const before = await snapshot();
    const d = await deps(t);
    expect(await runCalendarImportCli({ ...d, reportPath: join(dir, "r.json") }, confirm)).toBe(1);
    expect(await snapshot()).toEqual(before);
    expect(await readdir(d.storeDir)).toEqual([]);
    expect(JSON.parse(await readFile(join(dir, "r.json"), "utf8")).unknownKeys).toEqual([{ kind: "ministry", guid: GUID.unknown.toLowerCase() }]);
  });

  it("keeps legacy's two-space category name, and the Look Ahead still reads it as a speech (Survey 08)", async () => {
    await runCalendarImport(await deps(), confirm);
    const [cat] = await cal.db.select().from(categories).where(eq(categories.id, 16));
    expect(cat!.name).toBe("Sample  speech");
    const r = inferLookAhead({ categoryIds: [16], categoryNames: [cat!.name], contactMinistryAbbreviation: "FIN", isConfidential: false, isIssue: false, isConfirmed: true, commMaterialIds: [], startDate: "2027-01-22", endDate: "2027-01-22", currentSection: null }, TEST_RULES);
    expect(r).toEqual({ kind: "section", section: "events_and_speeches" });
  });

  it("records the counts the legacy survey couldn't", async () => {
    const f = (await runCalendarImport(await deps(), confirm)).toJSON().facts;
    expect(f).toMatchObject({ usersWithoutEmail: 2, usersWithInvalidEmail: 1, duplicateEmailGroups: 1, activityIdMin: 1001, activityIdMax: 1012, awarenessNotDeleted: 1, activitiesWithTwoOrMoreCategories: 1, historyRows: 4, historyRowsMostOnOneActivity: 3 });
  });

  it("records report.legacy() totals for activities and commContacts, and the report balances", async () => {
    const report = (await runCalendarImport(await deps(), confirm)).toJSON();
    expect(report.tables.activities!.legacy).toBe(14);
    expect(report.tables.commContacts!.legacy).toBe(6);
    expect(report.balanced).toBe(true);
  });

  it("surfaces CalendarUsersResult.groups so a merged duplicate-email pair can be reviewed, by user id only, never email", async () => {
    const report = (await runCalendarImport(await deps(), confirm)).toJSON();
    const id13 = (await core.db.select().from(userLegacyIds).where(eq(userLegacyIds.legacyId, "13")))[0]!.userId;
    const id14 = (await core.db.select().from(userLegacyIds).where(eq(userLegacyIds.legacyId, "14")))[0]!.userId;
    expect(id13).toBe(id14);
    const merge = report.notes.find((n: string) => n.includes("merged into Core user"));
    expect(merge).toBeDefined();
    expect(merge).toContain("13");
    expect(merge).toContain("14");
    expect(merge).toContain(id13);
    expect(JSON.stringify(report)).not.toContain("casey.shared");
  });

  it("stops before mapActivity and userCandidates run, when an unknown key is found", async () => {
    const t = legacyCalendarTables();
    (t.activitySharedWith as object[]).push({ ActivityId: 1001, ValueId: GUID.unknown, IsActive: true });
    const e = await runCalendarImport(await deps(t), { cutoff: TEST_CUTOFF, confirm: false }).catch((err: unknown) => err);
    expect(e).toBeInstanceOf(ImportStageError);
    expect((e as Error).message).toContain("calendar:import failed during keys");
    const json = (e as ImportStageError).report.toJSON();
    expect(json.unknownKeys).toEqual([{ kind: "ministry", guid: GUID.unknown.toLowerCase() }]);
    // balanceScope (legacy totals and release-link facts) already ran before the key check, but
    // mapActivity and userCandidates -- the next two stages -- never did: nothing was ever
    // "planned", and no fact that depends on a mapped activity or the user plan was recorded.
    expect(json.tables.activities!.legacy).toBe(14);
    expect(json.tables.activities!.planned).toBe(0);
    expect(json.tables.users!.planned).toBe(0);
    expect(json.facts).toEqual({ releaseLinksInScope: expect.any(Number), releaseLinksOutOfScope: expect.any(Number) });
  });

  it("a mid-run failure after the keys stage is still reported, with a non-zero exit code", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cal-report-"));
    const failingStore: ObjectStore = {
      async put() { throw new Error("disk full (synthetic failure for the test)"); },
      async get() { return null; },
      async delete() { return false; },
      async list() { return []; },
      publicPath: (key) => `/files/${key}`,
    };
    const d = await deps(undefined, failingStore);
    const code = await runCalendarImportCli({ ...d, reportPath: join(dir, "r.json") }, confirm);
    expect(code).toBe(1);
    const written = JSON.parse(await readFile(join(dir, "r.json"), "utf8"));
    expect(written.failed).toMatchObject({ stage: "files" });
    expect(written.balanced).toBe(false);
  });

  it("a favourite survives a failure partway through activities, once the cause is fixed and the run repeated", async () => {
    const bad = legacyCalendarTables();
    (bad.activities as Record<string, unknown>[]).find((a) => a.Id === 1004)!.CityId = 99999; // 1001 and 1002 commit (by id order) before this one fails
    const failure = await runCalendarImport(await deps(bad), confirm).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(ImportStageError);
    expect((failure as ImportStageError).stage).toBe("activities");
    // The failed run never reached the favourites stage at all, yet 1001's favourite is already
    // there: it was written in the same transaction as the activity, not as a later step.
    expect((await cal.db.select().from(favourites)).map((f) => f.activityId).sort()).toEqual([1001]);
    const report = (await runCalendarImport(await deps(), confirm)).toJSON();
    expect(report.balanced).toBe(true);
    expect((await cal.db.select().from(favourites)).map((f) => f.activityId).sort()).toEqual([1001, 1004]);
    expect(JSON.stringify(report)).not.toContain("its activity was imported before");
  });

  it("a mapping fallback (an unknown status, an out-of-range section, a dropped comm contact) reaches the report, by activity id and field only", async () => {
    const t = legacyCalendarTables();
    (t.activities as Record<string, unknown>[]).find((a) => a.Id === 1010)!.CommunicationContactId = 506; // no ministry: dropped
    const report = (await runCalendarImport(await deps(t), confirm)).toJSON();
    const forStatusAndSection = report.mapping.find((m) => m.activityId === 1012);
    expect(forStatusAndSection?.notes).toEqual(expect.arrayContaining([
      "HqSection 0 is not a legacy section; imported as Not on LA",
      "StatusId null imported as New",
    ]));
    const forDroppedContact = report.mapping.find((m) => m.activityId === 1010);
    expect(forDroppedContact?.notes).toContain("its comm contact wasn't imported");
    expect(JSON.stringify(report.mapping)).not.toContain("Sample");
  });

  it("lists users whose existing Core access was kept and users the import activated, by legacy id and Core user id; 'updated' counts only real changes", async () => {
    const [gray] = await core.db.insert(coreUsers).values({ email: "gray.sample@example.test", displayName: "Gray Core", isActive: true }).returning({ id: coreUsers.id });
    await core.db.insert(roleGrants).values({ userId: gray!.id, role: "Calendar.ReadOnly" });
    const report = (await runCalendarImport(await deps(), confirm)).toJSON();
    const id12 = (await core.db.select().from(userLegacyIds).where(eq(userLegacyIds.legacyId, "12")))[0]!.userId;
    const id19 = (await core.db.select().from(userLegacyIds).where(eq(userLegacyIds.legacyId, "19")))[0]!.userId;
    expect(report.usersActivated).toEqual(expect.arrayContaining([{ legacyIds: [12], userId: id12 }]));
    expect(report.usersAccessKept).toEqual(expect.arrayContaining([{ legacyIds: [19], userId: id19 }]));
    // legacy user 19 already had Calendar access in Core and nothing about it changed, so it must
    // land in "unchanged", not "updated" -- unlike before the fix, which counted every email match.
    expect(report.tables.users).toMatchObject({ inserted: 6, updated: 2, unchanged: 1 });
    expect(JSON.stringify(report)).not.toContain("gray.sample");
  });

  it("defaultReportPath lands under the app's own, git-ignored report directory, not the process's working directory", () => {
    const p = defaultReportPath(new Date("2026-11-20T18:04:05.678Z"));
    expect(p.endsWith("calendar-import-20261120T180405Z.json")).toBe(true);
    expect(p).toContain("import-reports");
    expect(isAbsolute(p)).toBe(true);
  });
});

describe("calendar:import from a CSV snapshot", () => {
  it("imports every activity, makes users from comm contacts, and reports the tables it never had as not provided", async () => {
    await core.db.execute(sql`TRUNCATE users, organizations, terms, outbox_events, outbox_deliveries, aggregate_sequences CASCADE`);
    const { snapshot, keys } = snapshotFromCsv(legacyCsvFiles(), { partC: partCFile(), usersFromCommContacts: true });
    expect(await seedCoreFromLegacyKeys(core.db, keys)).toBe("sample-hq");
    const d = await deps();
    const report = await runCalendarImport({ db: d.db, coreDb: d.coreDb, snapshot, store: d.store, rules: TEST_RULES, coreSubscribers: [] }, { cutoff: CSV_CUTOFF, confirm: true });
    const j = report.toJSON();
    expect(j.balanced).toBe(true);
    expect(j.tables.activities).toMatchObject({ legacy: 5, inserted: 5 });
    expect(j.tables.users).toMatchObject({ legacy: 3, inserted: 3 });
    expect(j.tables.commContacts).toMatchObject({ legacy: 4, inserted: 3, skipped: 1 });
    expect(Object.keys(j.tables)).not.toContain("favourites");
    expect(j.notProvided.map((n) => n.table)).toEqual(["userMinistries", "savedFilters", "favourites", "files", "logRows"]);
    expect(j.notes).toEqual(expect.arrayContaining(["users are made from comm contacts: names only, no email, no role, inactive"]));
    expect(j.facts).not.toHaveProperty("historyRows");
    expect(j.facts).not.toHaveProperty("usersWithoutEmail");
    expect((await cal.db.select({ id: activities.id }).from(activities).orderBy(asc(activities.id))).map((r) => r.id)).toEqual([41001, 41002, 41003, 41004, 41005]);
    const [a] = await cal.db.select({ commContactId: activities.commContactId }).from(activities).where(eq(activities.id, 41001));
    expect(a!.commContactId).toBe(501);
    expect((await cal.db.select({ id: calCommContacts.id }).from(calCommContacts).orderBy(asc(calCommContacts.id))).map((r) => r.id)).toEqual([501, 502, 503]);
    const made = await core.db.select({ name: coreUsers.displayName, email: coreUsers.email, active: coreUsers.isActive }).from(coreUsers).orderBy(asc(coreUsers.displayName));
    expect(made).toEqual([
      { name: "Sample Contact One", email: null, active: false },
      { name: "Sample Contact Two", email: null, active: false },
      { name: "Sample No Ministry", email: null, active: false },
    ]);
  });
});

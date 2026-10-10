import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import type { TestDatabase } from "@gcpe/db-kit";
import { listQuerySchema, type ListQueryInput } from "@gcpe/calendar-contract";
import { loadCalendarActor } from "../actor";
import { ActivityForbiddenError } from "../activities/errors";
import { inReadSnapshot } from "../activities/store";
import { activityCategories, activityInitiatives, activitySharedWith } from "../db/schema";
import type { ApiDeps } from "../http/routes";
import { scopeOf } from "../list/query";
import { rowsOf } from "../list/rows";
import { createCalendarTestDb, createTestApp, FIXED_NOW, TEST_RULES } from "../../test/helpers";
import { insertRaw, seedWorld, type Who, type World } from "../../test/world";
import { REPORT_ACTIVITY_LIMIT, ReportTooLargeError, reportData } from "./data";

type Key = "A" | "B" | "C" | "D" | "E" | "F" | "G" | "H";
const MARCH = { from: "2046-03-01", to: "2046-03-31" };

describe("what a report reads (spec addendum §6, §10)", () => {
  let tdb: TestDatabase;
  let w: World;
  let deps: ApiDeps;
  const ids = {} as Record<Key, number>;
  const keyOf = (id: number) => (Object.keys(ids) as Key[]).find((k) => ids[k] === id) ?? String(id);
  const read = async (who: Who, q: ListQueryInput = { filter: MARCH }, rules = TEST_RULES) =>
    reportData({ ...deps, rules }, (await loadCalendarActor(tdb.db, w.as[who].id))!, listQuerySchema.parse(q));

  beforeAll(async () => {
    tdb = await createCalendarTestDb();
    const app = createTestApp(tdb.db);
    w = await seedWorld(app, tdb.db);
    deps = { db: tdb.db, rules: TEST_RULES, subscribers: [], now: () => FIXED_NOW };
    // 2046-03-10 09:00 BC is 16:00Z. Inserted out of order: the report reads start date, end date, then start time.
    const make = async (k: Key, start: string, over: Parameters<typeof insertRaw>[1] = {}) => {
      ids[k] = await insertRaw(tdb.db, { title: `Report ${k}`, startAt: new Date(start), endAt: new Date(new Date(start).getTime() + 3_600_000), hqComments: `Sample summary ${k}`, hqStatus: "new", ...over });
      await tdb.db.insert(activityCategories).values({ activityId: ids[k], categoryId: k === "G" ? w.cat.awareness : w.cat.plain });
    };
    await make("H", "2046-03-12T16:00:00Z", { contactMinistryKey: "consult" });
    await make("G", "2046-03-11T16:00:00Z");
    await make("F", "2046-03-10T21:00:00Z", { deletedAt: new Date("2046-03-01T00:00:00Z"), needsReview: ["active"] });
    await make("E", "2046-03-10T20:00:00Z", { contactMinistryKey: "finance", isConfidential: true });
    await tdb.db.insert(activitySharedWith).values({ activityId: ids.E, ministryKey: "health" });
    await make("D", "2046-03-10T19:00:00Z", { contactMinistryKey: "finance", isConfidential: true });
    await make("C", "2046-03-10T18:00:00Z", { contactMinistryKey: "finance", nrAt: new Date("2046-03-10T18:30:00Z"), longTermOutlook: true, hqSection: "issues_and_reports" });
    await make("B", "2046-03-10T17:00:00Z", { isConfidential: true });
    await make("A", "2046-03-10T16:00:00Z");
    await tdb.db.insert(activityInitiatives).values({ activityId: ids.A, initiativeId: w.ids.initiative });
  });
  afterAll(() => tdb.drop());

  const ROLES: [Who, Key[]][] = [
    ["readOnly", ["A", "B", "E", "G"]],
    ["editor", ["A", "B", "E", "G"]],
    ["financeEditor", ["C", "D", "E"]],
    ["admin", ["A", "B", "E", "G"]],
    ["hqReadOnly", ["A", "C", "G", "H"]],
    ["hqEditor", ["A", "C", "G", "H"]],
    ["hqAdvanced", ["A", "B", "C", "D", "E", "G", "H"]],
    ["hqAdmin", ["A", "B", "C", "D", "E", "G", "H"]],
  ];
  for (const [who, keys] of ROLES) {
    it(`${who}: exactly the activities the list's visibility rule allows, never a deleted one, Awareness dates and the consultations ministry included`, async () => {
      expect((await read(who)).rows.map((r) => keyOf(r.id))).toEqual(keys);
    });
  }

  it("orders by start date, end date and start time whatever the list's sort", async () => {
    const d = await read("hqAdmin", { filter: MARCH, sort: "title", dir: "desc" });
    expect(d.rows.map((r) => keyOf(r.id))).toEqual(["A", "B", "C", "D", "E", "G", "H"]);
    expect(d.now).toEqual(FIXED_NOW);
  });

  it("the Executive Summary and LA status only where the Look Ahead fieldset shows (spec addendum §6, C177)", async () => {
    const summaryOf = async (who: Who, k: Key, rules = TEST_RULES) => (await read(who, { filter: MARCH }, rules)).rows.find((r) => r.id === ids[k])!;
    for (const who of ["hqEditor", "hqAdmin"] as const) {
      expect(await summaryOf(who, "A")).toMatchObject({ executiveSummary: "Sample summary A", hqStatus: "new" });
    }
    for (const who of ["editor", "admin", "hqReadOnly"] as const) {
      expect(await summaryOf(who, "A")).toMatchObject({ executiveSummary: null, hqStatus: null });
    }
    // ShowHqCommentsField on: an Editor sees it on their own ministry's activity, not on one only shared with them.
    const shown = { ...TEST_RULES, showHqCommentsField: true };
    expect((await summaryOf("editor", "A", shown)).executiveSummary).toBe("Sample summary A");
    expect((await summaryOf("editor", "E", shown)).executiveSummary).toBeNull();
  });

  it("carries the section, Long Term Outlook, NR time, category ids and initiative short names", async () => {
    const rows = (await read("hqAdmin")).rows;
    expect(rows.find((r) => r.id === ids.C)).toMatchObject({ hqSection: "issues_and_reports", longTermOutlook: true, nrAt: "2046-03-10T18:30:00.000Z" });
    expect(rows.find((r) => r.id === ids.A)).toMatchObject({ hqSection: "in_the_news", longTermOutlook: false, nrAt: null, categoryIds: [w.cat.plain], initiatives: ["SI"] });
    expect(rows.find((r) => r.id === ids.G)!.categoryIds).toEqual([w.cat.awareness]);
  });

  it("adds only the six report facts to the list's row, and a hidden Executive Summary leaves no trace", async () => {
    const actor = (await loadCalendarActor(tdb.db, w.as.editor.id))!;
    const [listRow] = await inReadSnapshot(tdb.db, async (tx) => rowsOf(tx, await scopeOf(tx, deps, actor), [ids.A]));
    const row = (await read("editor")).rows.find((r) => r.id === ids.A)!;
    const extra = Object.keys(row).filter((k) => !(k in listRow!));
    expect(extra.sort()).toEqual(["categoryIds", "executiveSummary", "hqSection", "initiatives", "longTermOutlook", "nrAt"]);
    expect(JSON.stringify(row)).not.toContain("Sample summary");
  });

  it("the HQ-only parts of the query stay HQ-only", async () => {
    await expect(read("admin", { filter: MARCH, lookAhead: "look_ahead_only" })).rejects.toBeInstanceOf(ActivityForbiddenError);
    await expect(read("editor", { corporate: { days: 7, statuses: ["new"] } })).rejects.toBeInstanceOf(ActivityForbiddenError);
  });

  it(`refuses more than ${REPORT_ACTIVITY_LIMIT} activities before reading their rows`, async () => {
    await tdb.db.execute(
      sql`INSERT INTO activities (title, details, significance, schedule, contact_ministry_key, start_at, end_at, is_confirmed, status, hq_section)
          SELECT 'Sample bulk', '', '', '', 'health', '2047-06-10T16:00:00Z', '2047-06-10T17:00:00Z', true, 'reviewed', 'in_the_news' FROM generate_series(1, ${REPORT_ACTIVITY_LIMIT + 1})`,
    );
    await expect(read("editor", { filter: { from: "2047-06-01", to: "2047-06-30" } })).rejects.toBeInstanceOf(ReportTooLargeError);
    await tdb.db.execute(sql`DELETE FROM activities WHERE title = 'Sample bulk' AND start_at = '2047-06-10T16:00:00Z' AND id IN (SELECT id FROM activities WHERE title = 'Sample bulk' LIMIT 1)`);
    expect((await read("editor", { filter: { from: "2047-06-01", to: "2047-06-30" } })).rows).toHaveLength(REPORT_ACTIVITY_LIMIT);
  });
});

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { TestDatabase } from "@gcpe/db-kit";
import type { FeedPage } from "@gcpe/calendar-contract";
import { activities, activitySharedWith } from "../db/schema";
import { createCalendarTestDb, createTestApp, TEST_RULES } from "../../test/helpers";
import { addEntry, bcAt, FEED_IDS, feedKeyOf, seedFeed } from "../../test/feed-world";
import { call, insertRaw, seedWorld, type Who, type World } from "../../test/world";

// Each list is newest first, as "<activity> <action>" (feed-world.ts). The matrix comes from spec
// addendum §6: own and shared-with ministries; HQ sees every ministry, confidential ones from
// Advanced; deleted activities only HQ Administrators; Look-Ahead-only changes only HQ Editor and above.
const HEALTH = ["G updated", "G created", "A reviewed", "A updated", "E created", "B created", "A created"];
const FINANCE = ["H cloned", "E created", "D created", "C created"];
const HQ_READ = ["G updated", "G created", "H cloned", "A reviewed", "A updated", "C created", "A created"];
const HQ_EDIT = ["G updated", "G updated", "G created", "H cloned", "A reviewed", "A updated", "C created", "A created"];
const HQ_ADVANCED = ["G updated", "G updated", "G created", "H cloned", "A reviewed", "A updated", "E created", "D created", "B created", "C created", "A created"];
const HQ_ADMIN = ["G updated", "G updated", "G created", "H cloned", "A reviewed", "F deleted", "F created", "A updated", "E created", "D created", "B created", "C created", "A created"];
const EXPECTED: Record<Who, string[]> = {
  readOnly: HEALTH, editor: HEALTH, advanced: HEALTH, admin: HEALTH, financeEditor: FINANCE,
  hqReadOnly: HQ_READ, hqEditor: HQ_EDIT, hqAdvanced: HQ_ADVANCED, hqAdmin: HQ_ADMIN,
};

describe("the updates feed (spec addendum §9.1)", () => {
  let tdb: TestDatabase;
  let w: World;
  let app: ReturnType<typeof createTestApp>;
  const feed = (who: Who, query: string, on = app) => call(on, "get", `/api/updates?${query}`, w.as[who].cookie);
  const labels = async (who: Who, query: string, on = app) => {
    const res = await feed(who, query, on);
    expect(res.status, `${who} ${query}`).toBe(200);
    return (res.body as FeedPage).items.map((i) => `${feedKeyOf(i.activityId)} ${i.action}`);
  };

  beforeAll(async () => {
    tdb = await createCalendarTestDb();
    app = createTestApp(tdb.db);
    w = await seedWorld(app, tdb.db);
    await seedFeed(tdb.db);
  });
  afterAll(() => tdb.drop());

  it("every role sees exactly the entries of the activities it can see, confidential and deleted ones included", async () => {
    for (const who of Object.keys(EXPECTED) as Who[]) {
      expect(await labels(who, "mode=range&from=2026-11-01&to=2026-11-03"), who).toEqual(EXPECTED[who]);
    }
  });

  it("Latest 5 updates: the five newest the user can see", async () => {
    expect(await labels("editor", "mode=latest")).toEqual(HEALTH.slice(0, 5));
    expect(await labels("hqAdmin", "mode=latest")).toEqual(HQ_ADMIN.slice(0, 5));
    expect(await labels("financeEditor", "mode=latest")).toEqual(FINANCE);
    const res = await feed("editor", "mode=latest");
    expect(res.body).toMatchObject({ mode: "latest", activityId: null, truncated: false });
  });

  it("Today's updates: BC's today by the database's clock", async () => {
    expect(await labels("editor", "mode=today")).toEqual(["G updated", "G created", "A reviewed"]);
    expect(await labels("hqAdmin", "mode=today")).toEqual(HQ_ADMIN.slice(0, 7));
  });

  it("a date range: whole BC days, From and To included, either left out; one kind of update", async () => {
    expect(await labels("hqAdmin", "mode=range&from=2026-11-01&to=2026-11-01")).toEqual(["C created", "A created"]);
    expect(await labels("hqAdmin", "mode=range&from=2026-11-03&to=2026-11-03")).toEqual(HQ_ADMIN.slice(0, 7));
    expect(await labels("financeEditor", "mode=range&from=2026-11-02")).toEqual(["H cloned", "E created", "D created"]);
    expect(await labels("hqAdmin", "mode=range&to=2026-11-01")).toEqual(["C created", "A created"]);
    expect(await labels("financeEditor", "mode=range")).toEqual(FINANCE);
    expect(await labels("financeEditor", "mode=range&from=2026-11-01&to=2026-11-03&type=created")).toEqual(["E created", "D created", "C created"]);
    expect(await labels("admin", "mode=range&type=deleted")).toEqual([]);
    expect(await labels("hqAdmin", "mode=range&type=deleted")).toEqual(["F deleted"]);
  });

  it("one activity's updates, newest first; one the user can't see, or that doesn't exist, is not found", async () => {
    expect(await labels("editor", `mode=activity&activity=${FEED_IDS.G}`)).toEqual(["G updated", "G created"]);
    expect(await labels("hqEditor", `mode=activity&activity=${FEED_IDS.G}`)).toEqual(["G updated", "G updated", "G created"]);
    expect(await labels("hqAdmin", `mode=activity&activity=${FEED_IDS.F}`)).toEqual(["F deleted", "F created"]);
    expect((await feed("editor", `mode=activity&activity=${FEED_IDS.G}`)).body).toMatchObject({ mode: "activity", activityId: FEED_IDS.G });
    const notFound = [
      await feed("financeEditor", `mode=activity&activity=${FEED_IDS.A}`),
      await feed("editor", `mode=activity&activity=${FEED_IDS.F}`),
      await feed("hqEditor", `mode=activity&activity=${FEED_IDS.B}`),
      await feed("editor", "mode=activity&activity=99999"),
    ];
    for (const res of notFound) {
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: "not found" });
    }
  });

  it("leaves out transfers, LA status clears and imported legacy log entries", async () => {
    expect(await labels("hqAdmin", `mode=activity&activity=${FEED_IDS.C}`)).toEqual(["C created"]);
    expect(await labels("hqAdmin", `mode=activity&activity=${FEED_IDS.A}`)).toEqual(["A reviewed", "A updated", "A created"]);
  });

  it("an entry that changed only Look Ahead fields shows only to those who see that fieldset on the activity", async () => {
    expect(await labels("editor", `mode=activity&activity=${FEED_IDS.G}`)).toEqual(["G updated", "G created"]);
    expect(await labels("hqReadOnly", `mode=activity&activity=${FEED_IDS.G}`)).toEqual(["G updated", "G created"]);
    expect(await labels("hqEditor", `mode=activity&activity=${FEED_IDS.G}`)).toEqual(["G updated", "G updated", "G created"]);
    // With the tenant's ShowHqCommentsField on, whoever may edit the activity sees the fieldset too.
    const shown = createTestApp(tdb.db, { rules: { ...TEST_RULES, showHqCommentsField: true } });
    expect(await labels("editor", `mode=activity&activity=${FEED_IDS.G}`, shown)).toEqual(["G updated", "G updated", "G created"]);
    expect(await labels("readOnly", `mode=activity&activity=${FEED_IDS.G}`, shown)).toEqual(["G updated", "G created"]);
  });

  it("each item carries the activity as it is now and who made the change; never an email or a field's value", async () => {
    const res = await feed("hqAdmin", `mode=activity&activity=${FEED_IDS.G}`);
    expect(res.body).toMatchObject({ mode: "activity", activityId: FEED_IDS.G, truncated: false });
    expect((res.body as FeedPage).items[0]).toEqual({
      id: expect.any(Number), at: "2026-11-03T17:55:00.000Z", action: "updated", actorName: "Sample Writer",
      activityId: FEED_IDS.G, ministryAbbreviation: "HLTH", title: "Feed G", details: "Sample details G",
      startAt: "2026-11-10T17:00:00.000Z", endAt: "2026-11-10T18:00:00.000Z", isAllDay: false, isConfirmed: true, potentialDates: null, isDeleted: false,
    });
    const deleted = await feed("hqAdmin", `mode=activity&activity=${FEED_IDS.F}`);
    expect((deleted.body as FeedPage).items.every((i) => i.isDeleted)).toBe(true);
    const everything = JSON.stringify((await feed("hqAdmin", "mode=range")).body);
    for (const never of ["@", "Sample executive summary", "Feed G old", "Kim Finance (FIN)"]) expect(everything).not.toContain(never);
  });
});

describe("the updates feed's day edges, and entries that follow their activity", () => {
  let tdb: TestDatabase;
  let w: World;
  let app: ReturnType<typeof createTestApp>;
  const K = 20011;
  const J = 20012;
  const actors = async (who: Who, query: string) => {
    const res = await call(app, "get", `/api/updates?${query}`, w.as[who].cookie);
    expect(res.status, `${who} ${query}`).toBe(200);
    return (res.body as FeedPage).items.map((i) => i.actorName);
  };

  beforeAll(async () => {
    tdb = await createCalendarTestDb();
    app = createTestApp(tdb.db);
    w = await seedWorld(app, tdb.db);
    await insertRaw(tdb.db, { id: K, title: "Sample edges" });
    const edges: [string, string][] = [
      ["Edge 1", "2026-01-16T07:59:59Z"], // 23:59:59 on Jan 15, PST
      ["Edge 2", "2026-01-16T08:00:00Z"], // 00:00:00 on Jan 16, PST
      ["Edge 3", "2026-11-03T06:59:59Z"], // 23:59:59 on Nov 2, permanent UTC−7
      ["Edge 4", "2026-11-03T07:00:00Z"], // 00:00:00 on Nov 3, today under FIXED_NOW
    ];
    for (const [actor, at] of edges) await addEntry(tdb.db, K, "updated", new Date(at), { actor, fields: [["title", "Sample a", "Sample b"]] });
    await insertRaw(tdb.db, { id: J, title: "Sample moving" });
    await addEntry(tdb.db, J, "created", bcAt("2026-10-20", "08:00"), { actor: "Moving" });
  });
  afterAll(() => tdb.drop());

  it("days are whole BC days, From and To included, on both sides of BC's move to UTC−7", async () => {
    expect(await actors("editor", "mode=range&from=2026-01-15&to=2026-01-15")).toEqual(["Edge 1"]);
    expect(await actors("editor", "mode=range&from=2026-01-16&to=2026-01-16")).toEqual(["Edge 2"]);
    expect(await actors("editor", "mode=range&from=2026-11-02&to=2026-11-02")).toEqual(["Edge 3"]);
    expect(await actors("editor", "mode=today")).toEqual(["Edge 4"]);
  });

  it("entries follow their activity's current visibility: made confidential, moved, shared back, deleted", async () => {
    const seen = async (who: Who) => (await call(app, "get", `/api/updates?mode=activity&activity=${J}`, w.as[who].cookie)).status;
    const inRange = (who: Who) => actors(who, "mode=range&from=2026-10-20&to=2026-10-20");
    const set = (over: Partial<typeof activities.$inferInsert>) => tdb.db.update(activities).set(over).where(eq(activities.id, J));

    expect([await seen("editor"), await seen("hqEditor"), await seen("financeEditor")]).toEqual([200, 200, 404]);
    await set({ isConfidential: true });
    expect([await seen("editor"), await seen("hqEditor"), await seen("hqAdvanced")]).toEqual([200, 404, 200]);
    expect(await inRange("hqEditor")).toEqual([]);
    expect(await inRange("editor")).toEqual(["Moving"]);
    await set({ contactMinistryKey: "finance" });
    expect([await seen("editor"), await seen("financeEditor")]).toEqual([404, 200]);
    await tdb.db.insert(activitySharedWith).values({ activityId: J, ministryKey: "health" });
    expect(await seen("editor")).toBe(200);
    await set({ deletedAt: bcAt("2026-11-03", "08:00") });
    expect([await seen("editor"), await seen("financeEditor"), await seen("hqAdvanced"), await seen("hqAdmin")]).toEqual([404, 404, 404, 200]);
    expect(await inRange("financeEditor")).toEqual([]);
    expect(await inRange("hqAdmin")).toEqual(["Moving"]);
  });
});

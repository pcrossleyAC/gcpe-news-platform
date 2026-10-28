import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import request from "supertest";
import type { OrgSucceeded } from "@gcpe/events";
import type { TestDatabase } from "@gcpe/db-kit";
import { createCalendarTestDb, createTestApp, envelope, projectOrg, sendEvent, sessionCookie, TEST_RULES } from "../test/helpers";
import { activities, activityChangeFields, activityChanges, activitySharedWith, commContacts, outboxEvents } from "./db/schema";
import { applySuccession, successionCounts } from "./succession";

const AT = new Date("2026-11-20T18:00:00Z"); // 11:00 BC
const DATA: OrgSucceeded = { key: "health", successorKeys: ["wellness"], moveSubscribers: true, moveCalendar: true, moveDrafts: true, takeAbbreviation: true, at: AT.toISOString() };
const U1 = "11111111-1111-4111-8111-111111111111";
const U2 = "22222222-2222-4222-8222-222222222222";

describe("calendar succession", () => {
  let tdb: TestDatabase;
  let app: ReturnType<typeof createTestApp>;
  beforeAll(async () => {
    tdb = await createCalendarTestDb();
    app = createTestApp(tdb.db);
    await projectOrg(app, "health", { displayName: "Health" });
    await projectOrg(app, "wellness", { displayName: "Wellness" });
  });
  afterAll(() => tdb.drop());
  beforeEach(async () => {
    await tdb.db.delete(activities);
    await tdb.db.delete(commContacts);
  });

  const act = async (title: string, over: Partial<typeof activities.$inferInsert> = {}) =>
    (await tdb.db.insert(activities).values({ title, contactMinistryKey: "health", ...over }).returning({ id: activities.id }))[0]!.id;
  const get = async (id: number) => (await tdb.db.select().from(activities).where(eq(activities.id, id)))[0]!;
  const run = (data = DATA) => tdb.db.transaction((tx) => applySuccession(tx, data, { rules: TEST_RULES, subscribers: [] }));

  it("moves only upcoming and undated activities", async () => {
    const future = await act("future", { startAt: new Date("2026-12-01T18:00:00Z") });
    const undated = await act("undated");
    const atExact = await act("exact", { startAt: AT });
    const allDayToday = await act("all-day today", { isAllDay: true, startAt: new Date("2026-11-20T07:00:00Z") }); // BC midnight, before `at`
    const allDayYesterday = await act("all-day yesterday", { isAllDay: true, startAt: new Date("2026-11-19T07:00:00Z") });
    const past = await act("past", { startAt: new Date("2026-11-01T18:00:00Z") });
    const otherMinistry = await act("other", { contactMinistryKey: "finance", startAt: new Date("2026-12-01T18:00:00Z") });
    const deleted = await act("deleted", { startAt: new Date("2026-12-01T18:00:00Z"), deletedAt: new Date() });
    expect(await run()).toEqual({ activities: 4, contacts: 0 });
    for (const id of [future, undated, atExact, allDayToday]) expect((await get(id)).contactMinistryKey).toBe("wellness");
    for (const id of [allDayYesterday, past, deleted]) expect((await get(id)).contactMinistryKey).toBe("health");
    expect((await get(otherMinistry)).contactMinistryKey).toBe("finance");
  });

  it("judges upcoming by BC midnight after the autumn-2026 change: the all-day cut is UTC-7 (tzdata 2026b)", async () => {
    // From 2026-11-02 the old rule (PST, UTC-8) and BC's permanent UTC-7 disagree on midnight, so
    // this fails on stale tzdata, which would put midnight at 08:00Z.
    const at = new Date("2026-11-02T20:00:00Z"); // 13:00 BC
    const today = await act("today", { isAllDay: true, startAt: new Date("2026-11-02T07:00:00Z") }); // 00:00 UTC-7
    const wrong = await act("an hour early", { isAllDay: true, startAt: new Date("2026-11-02T06:00:00Z") }); // Nov 1 23:00 BC
    expect(await successionCounts(tdb.db, "health", at)).toEqual({ activities: 1, contacts: 0 });
    await run({ ...DATA, at: at.toISOString() });
    expect((await get(today)).contactMinistryKey).toBe("wellness");
    expect((await get(wrong)).contactMinistryKey).toBe("health");
  });

  it("keeps past history", async () => {
    const past = await act("past", { startAt: new Date("2026-11-01T18:00:00Z") });
    await tdb.db.insert(activitySharedWith).values({ activityId: past, ministryKey: "health" });
    await run();
    expect((await get(past)).contactMinistryKey).toBe("health");
    expect((await tdb.db.select().from(activitySharedWith).where(eq(activitySharedWith.activityId, past))).map((r) => r.ministryKey)).toEqual(["health"]);
    expect(await tdb.db.select().from(activityChanges).where(eq(activityChanges.activityId, past))).toHaveLength(0);
  });

  it("re-keys shared-with, writes one system history change, and emits the activity", async () => {
    const a = await act("shared", { startAt: new Date("2026-12-01T18:00:00Z") });
    await tdb.db.insert(activitySharedWith).values([{ activityId: a, ministryKey: "health" }, { activityId: a, ministryKey: "finance" }]);
    const b = await act("shared with both", { startAt: new Date("2026-12-02T18:00:00Z") });
    await tdb.db.insert(activitySharedWith).values([{ activityId: b, ministryKey: "health" }, { activityId: b, ministryKey: "wellness" }]);
    const subscribers = [{ name: "nrms", url: "http://nrms.invalid/events", secret: "s", types: ["activity.*"] }] as never;
    await tdb.db.transaction((tx) => applySuccession(tx, DATA, { rules: TEST_RULES, subscribers }));
    const shared = async (id: number) => (await tdb.db.select().from(activitySharedWith).where(eq(activitySharedWith.activityId, id))).map((r) => r.ministryKey).sort();
    expect(await shared(a)).toEqual(["finance", "wellness"]);
    expect(await shared(b)).toEqual(["wellness"]);
    const changes = await tdb.db.select().from(activityChanges).where(eq(activityChanges.activityId, a));
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ actorName: "System", action: "updated", contactMinistryKey: "wellness" });
    const fields = await tdb.db.select().from(activityChangeFields).where(eq(activityChangeFields.changeId, changes[0]!.id));
    expect(fields).toMatchObject([{ fieldKey: "contact_ministry", oldValue: "Health", newValue: "Wellness" }]);
    const emitted = await tdb.db.select().from(outboxEvents).where(eq(outboxEvents.aggregateId, `activity:${a}`));
    expect(emitted.map((e) => e.type)).toEqual(["activity.updated"]);
  });

  it("moves a contact, or deactivates it when the person already has one on the successor", async () => {
    await tdb.db.insert(commContacts).values([
      { userId: U1, ministryKey: "health", rank: 2 },
      { userId: U2, ministryKey: "health", rank: 3 },
      { userId: U2, ministryKey: "wellness", rank: 1 },
    ]);
    expect(await run()).toEqual({ activities: 0, contacts: 2 });
    const rows = await tdb.db.select().from(commContacts);
    const of = (u: string, m: string) => rows.find((r) => r.userId === u && r.ministryKey === m);
    expect(of(U1, "wellness")).toMatchObject({ isActive: true, rank: 2 });
    expect(of(U1, "health")).toBeUndefined();
    expect(of(U2, "health")).toMatchObject({ isActive: false });
    expect(of(U2, "wellness")).toMatchObject({ isActive: true, rank: 1 });
  });

  it("an inactive contact already on the successor doesn't count as taken: the person keeps an active contact", async () => {
    await tdb.db.insert(commContacts).values([
      { userId: U2, ministryKey: "health", rank: 3, sortOrder: 5 },
      { userId: U2, ministryKey: "wellness", rank: 1, isActive: false },
    ]);
    expect(await run()).toEqual({ activities: 0, contacts: 1 });
    const rows = await tdb.db.select().from(commContacts);
    expect(rows.find((r) => r.ministryKey === "wellness")).toMatchObject({ isActive: true, rank: 3, sortOrder: 5 });
    expect(rows.find((r) => r.ministryKey === "health")).toMatchObject({ isActive: false });
  });

  it("idempotent on redelivery", async () => {
    await act("future", { startAt: new Date("2026-12-01T18:00:00Z") });
    await tdb.db.insert(commContacts).values({ userId: U1, ministryKey: "health" });
    expect(await run()).toEqual({ activities: 1, contacts: 1 });
    expect(await run()).toEqual({ activities: 0, contacts: 0 });
    const changes = await tdb.db.select().from(activityChanges);
    expect(changes).toHaveLength(1);
    // Through the receiver too: the event applies, and its copy is a duplicate.
    const later = await act("later", { startAt: new Date("2026-12-02T18:00:00Z") });
    const ev = envelope("core", "org.succeeded", DATA, "org:health");
    expect((await sendEvent(app, ev)).status).toBe(200);
    expect((await sendEvent(app, ev)).status).toBe(200);
    expect((await sendEvent(app, envelope("core", "org.succeeded", DATA, "org:health"))).status).toBe(200);
    expect((await get(later)).contactMinistryKey).toBe("wellness");
    expect(await tdb.db.select().from(activityChanges).where(eq(activityChanges.activityId, later))).toHaveLength(1);
    expect(await tdb.db.select().from(outboxEvents).where(eq(outboxEvents.aggregateId, `activity:${later}`))).toHaveLength(1);
  });

  it("is applied through the event receiver", async () => {
    const id = await act("future", { startAt: new Date("2026-12-01T18:00:00Z") });
    expect((await sendEvent(app, envelope("core", "org.succeeded", DATA, "org:health"))).status).toBe(200);
    expect((await get(id)).contactMinistryKey).toBe("wellness");
  });

  it("moveCalendar false is a no-op", async () => {
    const id = await act("future", { startAt: new Date("2026-12-01T18:00:00Z") });
    await tdb.db.insert(commContacts).values({ userId: U1, ministryKey: "health" });
    expect(await run({ ...DATA, moveCalendar: false })).toEqual({ activities: 0, contacts: 0 });
    expect((await get(id)).contactMinistryKey).toBe("health");
    expect((await tdb.db.select().from(commContacts))[0]!.ministryKey).toBe("health");
  });

  it("preview counts match what apply moves", async () => {
    await act("a", { startAt: new Date("2026-12-01T18:00:00Z") });
    await act("b");
    await act("past", { startAt: new Date("2026-11-01T18:00:00Z") });
    await tdb.db.insert(commContacts).values([{ userId: U1, ministryKey: "health" }, { userId: U2, ministryKey: "health" }]);
    const counts = await successionCounts(tdb.db, "health", AT);
    expect(counts).toEqual({ activities: 2, contacts: 2 });
    expect(await run()).toEqual(counts);
    expect(await successionCounts(tdb.db, "health", AT)).toEqual({ activities: 0, contacts: 0 });
  });

  it("the preview route reports the counts to a Core.Admin", async () => {
    await act("a", { startAt: new Date("2026-12-01T18:00:00Z") });
    const res = await request(app).get("/api/succession/health/preview").set("cookie", await sessionCookie(U1, ["Core.Admin"]));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ activities: 1, contacts: 0 });
    for (const bad of ["nope", "1", "2026-11-20", "2026-11-20T18:00:00"]) {
      expect((await request(app).get(`/api/succession/health/preview?at=${bad}`).set("cookie", await sessionCookie(U1, ["Core.Admin"]))).status, bad).toBe(400);
    }
    const later = await request(app).get("/api/succession/health/preview?at=2026-12-02T00:00:00-07:00").set("cookie", await sessionCookie(U1, ["Core.Admin"]));
    expect(later.body).toEqual({ activities: 0, contacts: 0 });
  });

  it("preview is 403 without Core.Admin", async () => {
    expect((await request(app).get("/api/succession/health/preview").set("cookie", await sessionCookie(U1, ["Calendar.SysAdmin"]))).status).toBe(403);
    expect((await request(app).get("/api/succession/health/preview")).status).toBe(401);
  });
});

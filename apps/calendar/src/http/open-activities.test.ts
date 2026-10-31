import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { TestDatabase } from "@gcpe/db-kit";
import { createCalendarTestDb, createTestApp, FIXED_NOW, TEST_RULES } from "../../test/helpers";
import { call, insertRaw, seedWorld, type World } from "../../test/world";
import { activitySharedWith } from "../db/schema";
import { openActivitiesOf } from "../users";

describe("a user's open activities, before deactivating (spec addendum §8.5)", () => {
  let tdb: TestDatabase;
  let w: World;
  let app: ReturnType<typeof createTestApp>;
  const open = (who: keyof World["as"], userId: string) => call(app, "get", `/api/users/${userId}/open-activities`, w.as[who].cookie);

  beforeAll(async () => {
    tdb = await createCalendarTestDb();
    app = createTestApp(tdb.db);
    w = await seedWorld(app, tdb.db);
  });
  afterAll(() => tdb.drop());

  it("lists the open activities of their active comm contacts, in date order", async () => {
    const c = w.contact.editorHealth;
    // FIXED_NOW is 2026-11-03 11:00 BC: "today" starts at 2026-11-03T07:00Z.
    const later = await insertRaw(tdb.db, { commContactId: c, title: "Sample later", startAt: new Date("2026-12-01T17:00:00Z"), endAt: new Date("2026-12-01T18:00:00Z") });
    const today = await insertRaw(tdb.db, { commContactId: c, title: "Sample today", startAt: new Date("2026-11-03T07:00:00Z"), endAt: new Date("2026-11-03T07:30:00Z") });
    const undated = await insertRaw(tdb.db, { commContactId: c, title: "Sample undated", startAt: null, endAt: null });
    await insertRaw(tdb.db, { commContactId: c, title: "Sample yesterday", startAt: new Date("2026-11-02T17:00:00Z"), endAt: new Date("2026-11-02T18:00:00Z") });
    await insertRaw(tdb.db, { commContactId: c, title: "Sample deleted", deletedAt: FIXED_NOW });
    const res = await open("admin", w.as.editor.id);
    expect(res.status).toBe(200);
    expect(res.body.activities.map((a: { id: number }) => a.id)).toEqual([today, later, undated]);
    expect(res.body.activities[0]).toMatchObject({ reference: `HLTH-${today}`, title: "Sample today", startDate: "2026-11-03" });
    expect(res.body.truncated).toBe(false);
    expect(res.body.otherCount).toBe(0);
  });

  it("an activity in a ministry the Administrator doesn't belong to is only counted, never described", async () => {
    const c = w.contact.financeEditor;
    const hidden = await insertRaw(tdb.db, { commContactId: c, contactMinistryKey: "finance", isConfidential: true, title: "Sample hidden" });
    const other = await insertRaw(tdb.db, { commContactId: c, contactMinistryKey: "finance", title: "Sample other ministry" });
    // Only shared with the Administrator's ministry: they can see it, but Transfer moves only what their ministry leads.
    const shared = await insertRaw(tdb.db, { commContactId: c, contactMinistryKey: "finance", title: "Sample shared" });
    await tdb.db.insert(activitySharedWith).values({ activityId: shared, ministryKey: "health" });
    // Neither counts: one has ended, one is deleted.
    await insertRaw(tdb.db, { commContactId: c, contactMinistryKey: "finance", title: "Sample ended", startAt: new Date("2026-11-02T17:00:00Z"), endAt: new Date("2026-11-02T18:00:00Z") });
    await insertRaw(tdb.db, { commContactId: c, contactMinistryKey: "finance", title: "Sample gone", deletedAt: FIXED_NOW });

    const ministry = await open("admin", w.as.financeEditor.id);
    expect(ministry.status).toBe(200);
    expect(ministry.body).toEqual({ activities: [], truncated: false, otherCount: 3 });
    const raw = JSON.stringify(ministry.body);
    for (const leak of ["Sample", "finance", "FIN", String(hidden), String(other), String(shared)]) expect(raw).not.toContain(leak);

    const hq = await open("hqAdmin", w.as.financeEditor.id);
    expect(hq.body.activities.map((a: { id: number }) => a.id).sort()).toEqual([hidden, other, shared].sort());
    expect(hq.body.otherCount).toBe(0);
  });

  it("a user who is nobody's comm contact has none at all", async () => {
    expect((await open("admin", w.as.readOnly.id)).body).toEqual({ activities: [], truncated: false, otherCount: 0 });
  });

  it("still lists activities after the user was set to Not a comm contact, as Transfer still moves them", async () => {
    const put = (rank: number | null) => call(app, "put", `/api/users/${w.as.advanced.id}/comm-contacts/health`, w.as.admin.cookie, { rank });
    const id = await insertRaw(tdb.db, { commContactId: w.contact.retiredHealth, title: "Sample retired contact's" });
    expect((await put(2)).status).toBe(200);
    expect((await put(null)).status).toBe(200);
    const res = await open("admin", w.as.advanced.id);
    expect(res.body).toMatchObject({ truncated: false, otherCount: 0 });
    expect(res.body.activities.map((a: { id: number }) => a.id)).toEqual([id]);
    // The preview lists exactly what Transfer would move from that comm contact.
    const transfer = await call(app, "get", `/api/transfer/preview?from=${w.contact.retiredHealth}&to=${w.contact.editorHealth}`, w.as.admin.cookie);
    expect(transfer.body.count).toBe(1);
  });

  it("says when the list is cut short", async () => {
    const actor = { level: 4, isHq: true, ministryKeys: ["gcpe-hq"] };
    const out = await openActivitiesOf({ db: tdb.db, rules: TEST_RULES, subscribers: [], now: () => FIXED_NOW }, actor, w.as.editor.id, { limit: 2 });
    expect(out).toMatchObject({ truncated: true });
    expect(out.activities).toHaveLength(2);
  });

  it("is Administrator-only, and 404 for an unknown user", async () => {
    expect((await open("advanced", w.as.editor.id)).status).toBe(403);
    expect((await open("admin", "00000000-0000-4000-8000-000000009999")).status).toBe(404);
    expect((await open("admin", "not-a-uuid")).status).toBe(404);
  });
});

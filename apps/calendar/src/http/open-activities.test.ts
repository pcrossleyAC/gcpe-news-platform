import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { TestDatabase } from "@gcpe/db-kit";
import { createCalendarTestDb, createTestApp, FIXED_NOW, TEST_RULES } from "../../test/helpers";
import { call, insertRaw, seedWorld, type World } from "../../test/world";
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
  });

  it("only what the Administrator can see, with no count of the rest", async () => {
    await insertRaw(tdb.db, { commContactId: w.contact.financeEditor, contactMinistryKey: "finance", isConfidential: true, title: "Sample hidden" });
    const ministry = await open("admin", w.as.financeEditor.id);
    expect(ministry.body).toEqual({ activities: [], truncated: false });
    const hq = await open("hqAdmin", w.as.financeEditor.id);
    expect(hq.body.activities.map((a: { title: string }) => a.title)).toContain("Sample hidden");
  });

  it("a user who is nobody's comm contact has none; an inactive comm contact's activities aren't theirs", async () => {
    expect((await open("admin", w.as.readOnly.id)).body).toEqual({ activities: [], truncated: false });
    await insertRaw(tdb.db, { commContactId: w.contact.retiredHealth, title: "Sample retired contact's" });
    expect((await open("admin", w.as.advanced.id)).body.activities).toEqual([]);
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

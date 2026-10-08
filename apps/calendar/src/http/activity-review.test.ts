import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import type { TestDatabase } from "@gcpe/db-kit";
import type { ActivityFields } from "@gcpe/calendar-contract";
import { createCalendarTestDb, createTestApp, FIXED_NOW } from "../../test/helpers";
import { call, historyOf, insertRaw, outboxOf, seedWorld, validInput, type World } from "../../test/world";
import { activities } from "../db/schema";

describe("review, review selected and Clear LA Status (spec addendum §7.1)", () => {
  let tdb: TestDatabase;
  let w: World;
  let app: ReturnType<typeof createTestApp>;
  const make = async (over: Partial<ActivityFields> = {}) => (await call(app, "post", "/api/activities", w.as.editor.cookie, validInput(w, over))).body.activity as { id: number; version: number; fields: ActivityFields };
  const row = async (id: number) => (await tdb.db.select().from(activities).where(eq(activities.id, id)))[0]!;
  const changed = async () => {
    const a = await make();
    const res = await call(app, "put", `/api/activities/${a.id}`, w.as.editor.cookie, { ...a.fields, title: "Changed", venue: "Sample hall", version: a.version, tabId: null });
    return res.body.activity as { id: number; version: number };
  };

  beforeAll(async () => {
    tdb = await createCalendarTestDb();
    app = createTestApp(tdb.db);
    w = await seedWorld(app, tdb.db);
  });
  afterAll(() => tdb.drop());

  describe("Review", () => {
    const review = (who: keyof World["as"], id: number, version: number) => call(app, "post", `/api/activities/${id}/review`, w.as[who].cookie, { version });

    it("HQ Advanced reviews: status reviewed, flags cleared, version bumped, history and an event (acceptance 5)", async () => {
      const a = await changed();
      expect(await row(a.id)).toMatchObject({ status: "changed", needsReview: ["title", "venue"] });
      const res = await review("hqAdvanced", a.id, a.version);
      expect(res.status).toBe(200);
      expect(await row(a.id)).toMatchObject({ status: "reviewed", needsReview: [], version: a.version + 1 });
      expect((await historyOf(tdb.db, a.id)).at(-1)).toMatchObject({ action: "reviewed", actorName: "Sample HQ Advanced", fields: { status: ["Changed", "Reviewed"] } });
      expect((await outboxOf(tdb.db, a.id)).at(-1)!.type).toBe("activity.updated");
    });

    it("on a deleted activity, an HQ Administrator's Review clears only the active flag", async () => {
      const id = await insertRaw(tdb.db, { deletedAt: FIXED_NOW, needsReview: ["title", "active"], status: "changed", version: 4 });
      expect((await review("hqAdmin", id, 4)).status).toBe(200);
      expect(await row(id)).toMatchObject({ needsReview: ["title"], status: "changed", version: 5 });
    });

    it("is refused below HQ Advanced, on a stale version, and on what the reviewer can't see", async () => {
      const a = await changed();
      expect((await review("hqEditor", a.id, a.version)).status).toBe(403);
      expect((await review("admin", a.id, a.version)).status).toBe(403);
      expect((await review("hqAdvanced", a.id, a.version - 1)).body).toMatchObject({ code: "version_conflict" });
      const gone = await insertRaw(tdb.db, { deletedAt: FIXED_NOW, needsReview: ["active"] });
      expect((await review("hqAdvanced", gone, 1)).status).toBe(404);
    });

    it("ignores edit locks, and the open editor's next save gets 409 (spec addendum §7.5)", async () => {
      const a = await changed();
      await call(app, "put", `/api/activities/${a.id}/lock`, w.as.editor.cookie, { tabId: "tab-a" });
      expect((await review("hqAdvanced", a.id, a.version)).status).toBe(200);
      const fields = (await call(app, "get", `/api/activities/${a.id}`, w.as.editor.cookie)).body.fields;
      expect((await call(app, "put", `/api/activities/${a.id}`, w.as.editor.cookie, { ...fields, version: a.version, tabId: "tab-a" })).body).toMatchObject({ code: "version_conflict" });
    });
  });

  describe("Review selected", () => {
    const reviewSelected = (who: keyof World["as"], items: { id: number; version: number }[]) => call(app, "post", "/api/activities/review-selected", w.as[who].cookie, { items });

    it("reviews the rows unchanged since the list loaded and reports the rest (ActivityHandler.ashx.cs:177-193)", async () => {
      const fresh = await changed();
      const moved = await changed();
      await call(app, "post", `/api/activities/${moved.id}/review`, w.as.hqAdvanced.cookie, { version: moved.version });
      const res = await reviewSelected("hqAdmin", [{ id: moved.id, version: moved.version }, { id: fresh.id, version: fresh.version }, { id: 99_999_999, version: 1 }]);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ reviewed: [fresh.id], skipped: [{ id: moved.id, reason: "changed" }, { id: 99_999_999, reason: "not_found" }] });
      expect((await row(fresh.id)).status).toBe("reviewed");
    });

    it("an activity deleted after the list loaded is skipped as changed", async () => {
      const a = await changed();
      await call(app, "delete", `/api/activities/${a.id}`, w.as.admin.cookie, { version: a.version });
      expect((await reviewSelected("hqAdmin", [{ id: a.id, version: a.version }])).body.skipped).toEqual([{ id: a.id, reason: "changed" }]);
    });

    it("works across batches: 150 rows in one request", async () => {
      const ids: number[] = [];
      for (let n = 0; n < 150; n++) ids.push(await insertRaw(tdb.db, { status: "changed", needsReview: ["title"] }));
      const res = await reviewSelected("hqAdmin", ids.map((id) => ({ id, version: 1 })));
      expect(res.body.reviewed).toHaveLength(150);
      const rows = await tdb.db.select({ status: activities.status }).from(activities).where(inArray(activities.id, ids));
      expect(rows.every((r) => r.status === "reviewed")).toBe(true);
    });

    it("needs HQ Administrator (C139), takes at most 500 items, each once", async () => {
      const a = await changed();
      expect((await reviewSelected("hqAdvanced", [{ id: a.id, version: a.version }])).status).toBe(403);
      expect((await reviewSelected("admin", [{ id: a.id, version: a.version }])).status).toBe(403);
      expect((await reviewSelected("hqAdmin", Array.from({ length: 501 }, (_, n) => ({ id: n + 1, version: 1 })))).status).toBe(400);
      expect((await reviewSelected("hqAdmin", [{ id: a.id, version: 1 }, { id: a.id, version: 1 }])).status).toBe(400);
    });
  });

  describe("Clear LA Status", () => {
    const clear = (who: keyof World["as"], days: number) => call(app, "post", "/api/activities/clear-la-status", w.as[who].cookie, { days });

    it("clears every visible activity starting by 00:00 BC on today + N days, past ones too (ActivityHandler.ashx.cs:1258-1274)", async () => {
      // FIXED_NOW is 2026-11-03 in BC; 3 days → the cutoff is 2026-11-06 00:00 BC (07:00Z).
      const past = await insertRaw(tdb.db, { hqStatus: "new", startAt: new Date("2026-10-01T17:00:00Z") });
      const atCutoff = await insertRaw(tdb.db, { hqStatus: "changed", startAt: new Date("2026-11-06T07:00:00Z") });
      const after = await insertRaw(tdb.db, { hqStatus: "new", startAt: new Date("2026-11-06T07:01:00Z") });
      const hidden = await insertRaw(tdb.db, { hqStatus: "new", startAt: new Date("2026-11-04T17:00:00Z"), contactMinistryKey: "finance", isConfidential: true });
      const res = await clear("hqEditor", 3);
      expect(res.status).toBe(200);
      expect(res.body.cleared).toBeGreaterThanOrEqual(2);
      expect((await row(past)).hqStatus).toBeNull();
      expect(await row(atCutoff)).toMatchObject({ hqStatus: null, version: 2 });
      expect((await row(after)).hqStatus).toBe("new");
      expect((await row(hidden)).hqStatus).toBe("new");
      expect((await historyOf(tdb.db, atCutoff)).at(-1)).toMatchObject({ action: "la_status_cleared", fields: { hq_status: ["Changed", null] } });
    });

    it("needs HQ Editor (C139) and 0 to 366 days", async () => {
      expect((await clear("admin", 3)).status).toBe(403);
      expect((await clear("hqReadOnly", 3)).status).toBe(403);
      expect((await clear("hqEditor", 367)).status).toBe(400);
      expect((await clear("hqEditor", -1)).status).toBe(400);
    });
  });
});

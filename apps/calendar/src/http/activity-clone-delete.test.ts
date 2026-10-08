import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { TestDatabase } from "@gcpe/db-kit";
import type { ActivityFields } from "@gcpe/calendar-contract";
import { createCalendarTestDb, createTestApp, FIXED_NOW } from "../../test/helpers";
import { call, historyOf, insertRaw, outboxOf, seedWorld, validInput, type World } from "../../test/world";
import { activities, activityLocks } from "../db/schema";

describe("clone and delete (spec addendum §7.1)", () => {
  let tdb: TestDatabase;
  let w: World;
  let clock = FIXED_NOW;
  let app: ReturnType<typeof createTestApp>;
  const make = async (over: Partial<ActivityFields> = {}, who: keyof World["as"] = "editor") =>
    (await call(app, "post", "/api/activities", w.as[who].cookie, validInput(w, over))).body.activity as { id: number; version: number; fields: ActivityFields };
  const row = async (id: number) => (await tdb.db.select().from(activities).where(eq(activities.id, id)))[0]!;

  beforeAll(async () => {
    tdb = await createCalendarTestDb();
    app = createTestApp(tdb.db, { now: () => clock });
    w = await seedWorld(app, tdb.db);
  });
  afterAll(() => tdb.drop());

  describe("clone", () => {
    it("copies the activity: release time cleared, notes empty, **, tags dropped, only the kept keyword, status new", async () => {
      const src = await make({
        nrDate: "2026-11-10", nrTime: "08:00", comments: "Sample notes", tagKeys: ["sample-tag"], keywordNames: ["Sample kept keyword", "sample tag"],
        translations: ["Sample language A"], eventPlannerId: w.ids.planner, videographerId: w.ids.videographer, venue: "Sample hall", sharedWithKeys: ["finance"],
      });
      await call(app, "put", `/api/activities/${src.id}`, w.as.editor.cookie, { ...src.fields, title: "Changed source", version: src.version, tabId: null });
      const res = await call(app, "post", `/api/activities/${src.id}/clone`, w.as.editor.cookie, {});
      expect(res.status).toBe(201);
      const c = res.body.activity;
      expect(c.id).not.toBe(src.id);
      expect(c).toMatchObject({ version: 1, status: "new", needsReview: [] });
      expect(c.fields).toMatchObject({
        title: "Changed source", nrDate: null, nrTime: null, comments: "", tagKeys: [], keywordNames: ["Sample kept keyword"],
        translations: ["Sample language A"], eventPlannerId: w.ids.planner, videographerId: w.ids.videographer, venue: "Sample hall", sharedWithKeys: ["finance"],
      });
      expect(await row(c.id)).toMatchObject({ hqComments: "**", hqStatus: null, createdBy: w.as.editor.id });
      expect((await row(src.id)).version).toBe(2);
    });

    it("names the source in a cloned history entry, and queues activity.created", async () => {
      const src = await make();
      const id = (await call(app, "post", `/api/activities/${src.id}/clone`, w.as.editor.cookie, {})).body.activity.id as number;
      const [h] = await historyOf(tdb.db, id);
      expect(h).toMatchObject({ action: "cloned", fields: { cloned_from: [null, String(src.id)], title: [null, "Sample activity"] } });
      expect((await outboxOf(tdb.db, id))[0]!.type).toBe("activity.created");
    });

    it("cloning an activity saved with a brand-new keyword succeeds (C146)", async () => {
      const src = await make({ keywordNames: ["Brand new clone tag", "Sample kept keyword"] });
      expect((await call(app, "post", `/api/activities/${src.id}/clone`, w.as.editor.cookie, {})).status).toBe(201);
    });

    it("needs edit rights and is frozen for ministry users", async () => {
      const src = await make({ sharedWithKeys: ["finance"] });
      expect((await call(app, "post", `/api/activities/${src.id}/clone`, w.as.financeEditor.cookie, {})).status).toBe(403);
      expect((await call(app, "post", `/api/activities/${src.id}/clone`, w.as.readOnly.cookie, {})).status).toBe(403);
      const secret = await make({ isConfidential: true });
      expect((await call(app, "post", `/api/activities/${secret.id}/clone`, w.as.hqEditor.cookie, {})).status).toBe(404);
      clock = new Date("2026-11-03T23:30:00Z");
      expect((await call(app, "post", `/api/activities/${src.id}/clone`, w.as.editor.cookie, {})).body).toMatchObject({ code: "freeze" });
      expect((await call(app, "post", `/api/activities/${src.id}/clone`, w.as.hqEditor.cookie, {})).status).toBe(201);
      clock = FIXED_NOW;
    });

    it("refuses a body", async () => expect((await call(app, "post", `/api/activities/${(await make()).id}/clone`, w.as.editor.cookie, { title: "x" })).status).toBe(400));

    describe("the carried-over contact ministry, checked exactly as create checks a new one", () => {
      it("refuses to clone into a ministry that's since been deactivated", async () => {
        const id = await insertRaw(tdb.db, { contactMinistryKey: "retired" });
        const res = await call(app, "post", `/api/activities/${id}/clone`, w.as.hqEditor.cookie, {});
        expect(res.status).toBe(422);
      });

      it("refuses to clone into a ministry with no orgs row at all", async () => {
        const id = await insertRaw(tdb.db, { contactMinistryKey: "no-such-ministry" });
        const res = await call(app, "post", `/api/activities/${id}/clone`, w.as.hqEditor.cookie, {});
        expect(res.status).toBe(422);
      });

      it("refuses a shared-with ministry editor cloning another ministry's activity, as create would", async () => {
        const src = await make({ sharedWithKeys: ["finance"] });
        const res = await call(app, "post", `/api/activities/${src.id}/clone`, w.as.financeEditor.cookie, {});
        expect(res.status).toBe(403);
      });

      it("an HQ Editor still clones an activity whose ministry is fine", async () => {
        const src = await make();
        expect((await call(app, "post", `/api/activities/${src.id}/clone`, w.as.hqEditor.cookie, {})).status).toBe(201);
      });
    });
  });

  describe("delete", () => {
    const del = (who: keyof World["as"], id: number, version: number) => call(app, "delete", `/api/activities/${id}`, w.as[who].cookie, { version });

    it("an Administrator with edit rights deletes: deleted_at, the active flag, history, activity.deleted, locks gone", async () => {
      const a = await make();
      await call(app, "put", `/api/activities/${a.id}/lock`, w.as.admin.cookie, { tabId: "admin-tab" });
      expect((await del("admin", a.id, a.version)).status).toBe(204);
      expect(await row(a.id)).toMatchObject({ deletedAt: FIXED_NOW, deletedBy: w.as.admin.id, needsReview: ["active"], version: 2, status: "new" });
      expect((await historyOf(tdb.db, a.id)).map((h) => h.action)).toEqual(["created", "deleted"]);
      const last = (await outboxOf(tdb.db, a.id)).at(-1)!;
      expect(last.type).toBe("activity.deleted");
      expect(last.data).toEqual({ id: a.id });
      expect(await tdb.db.select().from(activityLocks).where(eq(activityLocks.activityId, a.id))).toEqual([]);
    });

    it("afterwards only HQ Administrators see it (spec addendum §6)", async () => {
      const a = await make();
      await del("admin", a.id, a.version);
      expect((await call(app, "get", `/api/activities/${a.id}`, w.as.admin.cookie)).status).toBe(404);
      expect((await call(app, "get", `/api/activities/${a.id}`, w.as.hqAdvanced.cookie)).status).toBe(404);
      const seen = await call(app, "get", `/api/activities/${a.id}`, w.as.hqAdmin.cookie);
      expect(seen.body).toMatchObject({ isDeleted: true, can: { edit: false, delete: false, clone: false, review: true } });
      expect((await del("hqAdmin", a.id, 2)).body).toMatchObject({ code: "deleted" });
    });

    it("refuses an Editor (403), a stale version (409), someone else's live lock (423) and the freeze (423)", async () => {
      const a = await make();
      expect((await del("editor", a.id, a.version)).status).toBe(403);
      expect((await del("admin", a.id, a.version + 1)).body).toMatchObject({ code: "version_conflict" });
      await call(app, "put", `/api/activities/${a.id}/lock`, w.as.editor.cookie, { tabId: "tab-a" });
      expect((await del("admin", a.id, a.version)).body).toMatchObject({ code: "locked" });
      await call(app, "post", `/api/activities/${a.id}/lock/release`, w.as.editor.cookie, { tabId: "tab-a" });
      clock = new Date("2026-11-03T23:30:00Z");
      expect((await del("admin", a.id, a.version)).body).toMatchObject({ code: "freeze" });
      expect((await del("hqAdmin", a.id, a.version)).status).toBe(204);
      clock = FIXED_NOW;
    });

    it("a malformed body is 400", async () => {
      const a = await make();
      expect((await call(app, "delete", `/api/activities/${a.id}`, w.as.admin.cookie, {})).status).toBe(400);
    });
  });
});

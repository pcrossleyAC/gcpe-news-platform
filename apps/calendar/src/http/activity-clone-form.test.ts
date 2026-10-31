import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { TestDatabase } from "@gcpe/db-kit";
import type { ActivityFields } from "@gcpe/calendar-contract";
import { createCalendarTestDb, createTestApp, FIXED_NOW } from "../../test/helpers";
import { call, historyOf, insertRaw, outboxOf, seedWorld, validInput, type World } from "../../test/world";
import { activities, cities } from "../db/schema";
import { loadStored, type StoredActivity } from "../activities/store";

/**
 * Clone as an unsaved form (owner, 2026-10-31, suite review CAL-1): GET .../clone gives the New
 * activity form what the server's clone copies, creating nothing; POST /activities with
 * `clonedFrom` creates it and records "cloned from" in its history.
 */
describe("clone as a pre-filled, unsaved form", () => {
  let tdb: TestDatabase;
  let w: World;
  let clock = FIXED_NOW;
  let app: ReturnType<typeof createTestApp>;
  const make = async (over: Partial<ActivityFields> = {}, who: keyof World["as"] = "editor") =>
    (await call(app, "post", "/api/activities", w.as[who].cookie, validInput(w, over))).body.activity as { id: number; version: number; fields: ActivityFields };
  const row = async (id: number) => (await tdb.db.select().from(activities).where(eq(activities.id, id)))[0]!;
  const count = async () => (await tdb.db.select({ id: activities.id }).from(activities)).length;

  beforeAll(async () => {
    tdb = await createCalendarTestDb();
    app = createTestApp(tdb.db, { now: () => clock });
    w = await seedWorld(app, tdb.db);
  });
  afterAll(() => tdb.drop());

  describe("GET /activities/:id/clone", () => {
    it("gives the clone's fields and creates nothing: release time cleared, notes empty, tags dropped, only the kept keyword", async () => {
      const src = await make({
        nrDate: "2026-11-10", nrTime: "08:00", comments: "Sample notes", tagKeys: ["sample-tag"], keywordNames: ["Sample kept keyword", "sample tag"],
        translations: ["Sample language A"], eventPlannerId: w.ids.planner, venue: "Sample hall", sharedWithKeys: ["finance"],
      });
      await tdb.db.update(activities).set({ hqSection: "events_and_speeches", longTermOutlook: true, hqComments: "Sample summary for HQ", hqStatus: "new" }).where(eq(activities.id, src.id));
      const before = await count();
      const res = await call(app, "get", `/api/activities/${src.id}/clone`, w.as.hqEditor.cookie);
      expect(res.status).toBe(200);
      expect(res.body.sourceId).toBe(src.id);
      expect(res.body.fields).toMatchObject({
        title: "Sample activity", startDate: "2026-11-10", endDate: "2026-11-10", nrDate: null, nrTime: null, comments: "", tagKeys: [], keywordNames: ["Sample kept keyword"],
        translations: ["Sample language A"], eventPlannerId: w.ids.planner, venue: "Sample hall", sharedWithKeys: ["finance"], contactMinistryKey: "health",
        commContactId: w.contact.editorHealth,
        lookAhead: { hqComments: "**", hqStatus: null, hqSection: "events_and_speeches", longTermOutlook: true },
      });
      expect(await count()).toBe(before);
    });

    it("leaves the Look Ahead fields out for someone who doesn't see them", async () => {
      const src = await make();
      const res = await call(app, "get", `/api/activities/${src.id}/clone`, w.as.editor.cookie);
      expect(res.status).toBe(200);
      expect(res.body.fields).not.toHaveProperty("lookAhead");
    });

    it("needs the right to clone: 403 for a shared-with ministry, 404 when not visible, 409 when deleted", async () => {
      const src = await make({ sharedWithKeys: ["finance"] });
      expect((await call(app, "get", `/api/activities/${src.id}/clone`, w.as.financeEditor.cookie)).status).toBe(403);
      expect((await call(app, "get", `/api/activities/${src.id}/clone`, w.as.readOnly.cookie)).status).toBe(403);
      const secret = await make({ isConfidential: true });
      expect((await call(app, "get", `/api/activities/${secret.id}/clone`, w.as.hqEditor.cookie)).status).toBe(404);
      const gone = await insertRaw(tdb.db, { deletedAt: FIXED_NOW });
      expect((await call(app, "get", `/api/activities/${gone}/clone`, w.as.hqAdmin.cookie)).body).toMatchObject({ code: "deleted" });
    });
  });

  describe("POST /activities with clonedFrom", () => {
    it("creates the activity and records that it was cloned, from which activity", async () => {
      const src = await make();
      const prefill = (await call(app, "get", `/api/activities/${src.id}/clone`, w.as.editor.cookie)).body.fields as ActivityFields;
      const res = await call(app, "post", "/api/activities", w.as.editor.cookie, { ...prefill, title: "Sample second date", clonedFrom: src.id });
      expect(res.status).toBe(201);
      const id = res.body.id as number;
      const [h] = await historyOf(tdb.db, id);
      expect(h).toMatchObject({ action: "cloned", fields: { cloned_from: [null, String(src.id)], title: [null, "Sample second date"] } });
      expect((await outboxOf(tdb.db, id))[0]!.type).toBe("activity.created");
    });

    it("gives someone who doesn't see the Look Ahead fields the clone's: ** and the source's section and Long Term Outlook", async () => {
      const src = await make();
      await tdb.db.update(activities).set({ hqSection: "events_and_speeches", longTermOutlook: true, hqComments: "Sample summary for HQ" }).where(eq(activities.id, src.id));
      const prefill = (await call(app, "get", `/api/activities/${src.id}/clone`, w.as.editor.cookie)).body.fields as ActivityFields;
      const id = (await call(app, "post", "/api/activities", w.as.editor.cookie, { ...prefill, clonedFrom: src.id })).body.id as number;
      expect(await row(id)).toMatchObject({ hqComments: "**", hqStatus: null, hqSection: "events_and_speeches", longTermOutlook: true, status: "new" });
    });

    it("keeps an inactive value the source holds, as the clone always has, but checks the lead ministry as a new choice", async () => {
      const [old] = await tdb.db.insert(cities).values({ name: "Sample old city", isActive: false, sortOrder: 0 }).returning({ id: cities.id });
      const src = await insertRaw(tdb.db, { cityId: old!.id, commContactId: w.contact.editorHealth });
      // An imported activity can lack a category; the form asks for one, as any save does.
      const prefill = { ...((await call(app, "get", `/api/activities/${src}/clone`, w.as.editor.cookie)).body.fields as ActivityFields), categoryId: w.cat.plain };
      const ok = await call(app, "post", "/api/activities", w.as.editor.cookie, { ...prefill, clonedFrom: src });
      expect(ok.status).toBe(201);
      // Without clonedFrom the same values are a plain create, which refuses the inactive city.
      expect((await call(app, "post", "/api/activities", w.as.editor.cookie, prefill)).status).toBe(422);

      const retired = await insertRaw(tdb.db, { contactMinistryKey: "retired" });
      const before = await count();
      const res = await call(app, "post", "/api/activities", w.as.hqEditor.cookie, { ...validInput(w, { contactMinistryKey: "retired", commContactId: null }), clonedFrom: retired });
      expect(res.status).toBe(422);
      expect(await count()).toBe(before);
    });

    it("refuses a source the user can no longer clone, and creates nothing", async () => {
      const src = await make({ sharedWithKeys: ["finance"] });
      const gone = await insertRaw(tdb.db, { deletedAt: FIXED_NOW });
      const before = await count();
      const res = await call(app, "post", "/api/activities", w.as.financeEditor.cookie, { ...validInput(w, { contactMinistryKey: "finance", commContactId: null }), clonedFrom: src.id });
      expect(res.status).toBe(422);
      expect(res.body.errors).toEqual([{ field: "", message: "You can no longer copy the activity this was copied from. Start a new activity instead." }]);
      expect((await call(app, "post", "/api/activities", w.as.editor.cookie, { ...validInput(w), clonedFrom: gone })).status).toBe(422);
      expect(await count()).toBe(before);
    });

    it("is frozen for ministry users, as a create is", async () => {
      const src = await make();
      clock = new Date("2026-11-03T23:30:00Z");
      expect((await call(app, "post", "/api/activities", w.as.editor.cookie, { ...validInput(w), clonedFrom: src.id })).body).toMatchObject({ code: "freeze" });
      clock = FIXED_NOW;
    });
  });

  /**
   * POST /activities/:id/clone stays for a Hub tab opened before the form clone was deployed. Both
   * paths must make the same activity, so a change to one can't quietly make them drift.
   */
  describe("the server clone and the form clone make the same activity", () => {
    const comparable = (s: StoredActivity | null) => {
      const { id: _id, createdAt: _c, createdBy: _cb, lastUpdatedAt: _u, lastUpdatedBy: _ub, version: _v, ...row } = s!.row;
      return { row, joins: s!.joins, keywordNames: s!.keywordNames };
    };
    for (const who of ["editor", "hqEditor", "hqAdmin"] as const) {
      it(`for ${who === "editor" ? "a ministry editor" : who}: row, joins, keywords and history alike`, async () => {
        const src = await make({
          nrDate: "2026-11-10", nrTime: "08:00", comments: "Sample notes", tagKeys: ["sample-tag"], keywordNames: ["Sample kept keyword", "sample tag"],
          translations: ["Sample language A"], eventPlannerId: w.ids.planner, venue: "  Sample hall ", sharedWithKeys: ["finance"],
          isAllDay: true, startTime: null, endTime: null, endDate: "2026-11-12", strategy: "Sample strategy", leadOrganization: "Sample org", potentialDates: "late June",
        });
        await tdb.db.update(activities).set({ hqSection: "events_and_speeches", longTermOutlook: true, hqComments: "Sample summary", hqStatus: "new" }).where(eq(activities.id, src.id));
        const viaServer = (await call(app, "post", `/api/activities/${src.id}/clone`, w.as[who].cookie, {})).body.id as number;
        const prefill = (await call(app, "get", `/api/activities/${src.id}/clone`, w.as[who].cookie)).body.fields as ActivityFields;
        const res = await call(app, "post", "/api/activities", w.as[who].cookie, { ...prefill, clonedFrom: src.id });
        expect(res.status).toBe(201);
        const viaForm = res.body.id as number;
        expect(comparable(await loadStored(tdb.db, viaForm))).toEqual(comparable(await loadStored(tdb.db, viaServer)));
        const [a] = await historyOf(tdb.db, viaServer);
        const [b] = await historyOf(tdb.db, viaForm);
        expect(b!.action).toBe(a!.action);
        expect(b!.fields).toEqual(a!.fields);
      });
    }
  });
});

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { TestDatabase } from "@gcpe/db-kit";
import { outboxEvents } from "@gcpe/events";
import { createCalendarTestDb, createTestApp, projectUser, sessionCookie } from "../../test/helpers";
import { call, outboxOf, seedWorld, validInput, type World } from "../../test/world";
import { activities, activityChangeFields, activityChanges, keywords } from "../db/schema";

describe("creating an activity (spec addendum §7.1)", () => {
  let tdb: TestDatabase;
  let app: ReturnType<typeof createTestApp>;
  let w: World;
  const create = (who: keyof World["as"], over = {}) => call(app, "post", "/api/activities", w.as[who].cookie, validInput(w, over));

  beforeAll(async () => {
    tdb = await createCalendarTestDb();
    app = createTestApp(tdb.db);
    w = await seedWorld(app, tdb.db);
  });
  afterAll(() => tdb.drop());

  it("an Editor creates in their ministry: status new, no flags, version 1, every field kept (C145)", async () => {
    const res = await create("editor", {
      title: "  “Sample”\nlaunch ", nrDate: "2026-11-10", nrTime: "08:00", translations: ["Sample language A"],
      keywordNames: ["Brand new tag"], sectorKeys: ["sample-sector"], tagKeys: ["sample-tag"], sharedWithKeys: ["finance"],
    });
    expect(res.status).toBe(201);
    const a = res.body.activity;
    expect(a).toMatchObject({ version: 1, status: "new", isDeleted: false, needsReview: [], lookAhead: null });
    expect(a.fields).toMatchObject({ title: '"Sample" launch', nrDate: "2026-11-10", nrTime: "08:00", translations: ["Sample language A"], keywordNames: ["Brand new tag"], sharedWithKeys: ["finance"] });
    expect(a.startAt).toBe("2026-11-10T16:00:00.000Z");
    expect((await tdb.db.select().from(keywords).where(eq(keywords.name, "Brand new tag"))).length).toBe(1);
  });

  it("a non-HQ, non-Administrator creator's Executive Summary is ** (Activity.aspx.cs:1098-1102); an Administrator's is empty", async () => {
    const ed = (await create("editor")).body.activity.id as number;
    const ad = (await create("admin", { commContactId: w.contact.adminHealth })).body.activity.id as number;
    const rows = await tdb.db.select({ id: activities.id, hq: activities.hqComments }).from(activities);
    expect(rows.find((r) => r.id === ed)!.hq).toBe("**");
    expect(rows.find((r) => r.id === ad)!.hq).toBeNull();
  });

  it("an HQ Editor sees and sets the Look Ahead fields; leaving them out gives legacy's defaults", async () => {
    const chosen = await create("hqEditor", { contactMinistryKey: "finance", commContactId: w.contact.financeEditor, details: "", lookAhead: { hqComments: "Sample summary", hqStatus: "new", hqSection: "events_and_speeches", longTermOutlook: true } });
    expect(chosen.status).toBe(201);
    expect(chosen.body.activity.lookAhead).toMatchObject({ hqComments: "Sample summary", hqStatus: "new", hqSection: "events_and_speeches", longTermOutlook: true, inferred: { kind: "section", section: "in_the_news" } });
    const defaults = await create("hqEditor", { contactMinistryKey: "finance", commContactId: w.contact.financeEditor });
    expect(defaults.body.activity.lookAhead).toMatchObject({ hqComments: "**", hqStatus: null, hqSection: "in_the_news", longTermOutlook: false });
  });

  it("who may create where (spec addendum §6)", async () => {
    expect((await create("readOnly")).status).toBe(403);
    const otherMinistry = await create("editor", { contactMinistryKey: "finance", commContactId: w.contact.financeEditor });
    expect(otherMinistry.status).toBe(422);
    expect(otherMinistry.body.errors).toContainEqual({ field: "contactMinistryKey", message: "You can only choose one of your ministries" });
    expect((await create("hqEditor", { contactMinistryKey: "retired" })).body.errors.map((e: { field: string }) => e.field)).toContain("contactMinistryKey");
    expect((await create("hqEditor", { contactMinistryKey: "excluded" })).body.errors.map((e: { field: string }) => e.field)).toContain("contactMinistryKey");
  });

  it("refuses a lead ministry the organization projection doesn't have, or has inactive, with a field error", async () => {
    const unknown = await create("hqEditor", { contactMinistryKey: "no-such-ministry" });
    expect(unknown.status).toBe(422);
    expect(unknown.body.errors).toContainEqual({ field: "contactMinistryKey", message: "That ministry doesn't exist" });
    const inactive = await create("hqEditor", { contactMinistryKey: "retired" });
    expect(inactive.status).toBe(422);
    expect(inactive.body.errors).toContainEqual({ field: "contactMinistryKey", message: "That ministry is no longer active" });
  });

  it("ministry keys compare byte for byte: a differently cased key is not the Editor's ministry", async () => {
    const res = await create("editor", { contactMinistryKey: "Health" });
    expect(res.status).toBe(422);
    expect(res.body.errors.map((e: { field: string }) => e.field)).toContain("contactMinistryKey");
  });

  it("an Editor with no ministry can't create anywhere: 403", async () => {
    const id = "00000000-0000-4000-8000-000000000499";
    await projectUser(app, { id, email: "nobody@example.test", displayName: "Sample Unassigned", isActive: true, calendarRole: "Calendar.Editor", organizationKeys: [] });
    expect((await call(app, "post", "/api/activities", await sessionCookie(id), validInput(w))).status).toBe(403);
  });

  it("a refused create writes nothing: no activity, no history, no event, no keyword", async () => {
    const count = async () => ({
      activities: (await tdb.db.select({ id: activities.id }).from(activities)).length,
      changes: (await tdb.db.select({ id: activityChanges.id }).from(activityChanges)).length,
      events: (await tdb.db.select({ id: outboxEvents.id }).from(outboxEvents)).length,
      keywords: (await tdb.db.select({ id: keywords.id }).from(keywords)).length,
    });
    const before = await count();
    expect((await create("editor", { keywordNames: ["Sample unsaved keyword"], startTime: "09:02" })).status).toBe(422);
    expect(await count()).toEqual(before);
  });

  it("an HQ Tag matches an existing keyword case-insensitively and keeps the keyword's own spelling", async () => {
    const before = (await tdb.db.select({ id: keywords.id }).from(keywords)).length;
    const res = await create("editor", { keywordNames: ["SAMPLE KEPT KEYWORD", "sample kept keyword"] });
    expect(res.status).toBe(201);
    expect(res.body.activity.fields.keywordNames).toEqual(["Sample kept keyword"]);
    expect((await tdb.db.select({ id: keywords.id }).from(keywords)).length).toBe(before);
  });

  it.each<[string, (w: World) => object, string]>([
    ["a release category without origin", (w) => ({ categoryId: w.cat.approvedRelease, nrDistributionId: 1, commMaterialIds: [1] }), "nrOriginId"],
    ["an end before the start", () => ({ endDate: "2026-11-09" }), "endDate"],
    ["a time off the 5-minute steps", () => ({ startTime: "09:02" }), "startTime"],
    ["Potential Dates with TBD", () => ({ potentialDates: "TBD" }), "potentialDates"],
    ["a 101-character title", () => ({ title: "x".repeat(101) }), "title"],
    ["an unknown category", () => ({ categoryId: 9999 }), "categoryId"],
    ["an inactive category", (w) => ({ categoryId: w.cat.retired }), "categoryId"],
    ["the HQ Placeholder category, by a ministry user", (w) => ({ categoryId: w.cat.hqPlaceholder }), "categoryId"],
    ["an inactive city", (w) => ({ cityId: w.city.retired }), "cityId"],
    ["an inactive comm material", (w) => ({ commMaterialIds: [w.commMaterial.retired] }), "commMaterialIds"],
    ["an inactive comm contact", (w) => ({ commContactId: w.contact.retiredHealth }), "commContactId"],
    ["another ministry's comm contact", (w) => ({ commContactId: w.contact.financeEditor }), "commContactId"],
    ["an unknown sector", () => ({ sectorKeys: ["no-such-sector"] }), "sectorKeys"],
    ["an inactive News Subscribe tag", () => ({ tagKeys: ["retired-tag"] }), "tagKeys"],
    ["an excluded shared-with ministry", () => ({ sharedWithKeys: ["excluded"] }), "sharedWithKeys"],
    ["Look Ahead fields from a ministry user", () => ({ lookAhead: { hqComments: "", hqStatus: null, hqSection: "in_the_news", longTermOutlook: false } }), "lookAhead"],
  ])("refuses %s with a field error, through the API (acceptance 7)", async (_name, over, field) => {
    const res = await create("editor", over(w));
    expect(res.status).toBe(422);
    expect(res.body.errors.map((e: { field: string }) => e.field)).toContain(field);
  });

  it("HQ may use the HQ Placeholder category", async () => {
    expect((await create("hqEditor", { categoryId: w.cat.hqPlaceholder })).status).toBe(201);
  });

  it("the server owns status, flags and versions: a body that sets them is 400", async () => {
    for (const extra of [{ status: "reviewed" }, { needsReview: ["title"] }, { version: 3 }, { createdBy: w.as.editor.id }]) {
      const res = await call(app, "post", "/api/activities", w.as.editor.cookie, { ...validInput(w), ...extra });
      expect(res.status).toBe(400);
    }
  });

  it("an all-day activity on 2026-11-01 stores and reads back BC's dates", async () => {
    const res = await create("editor", { isAllDay: true, startDate: "2026-11-01", endDate: "2026-11-01", startTime: null, endTime: null });
    expect(res.status).toBe(201);
    expect(res.body.activity).toMatchObject({ startAt: "2026-11-01T07:00:00.000Z", endAt: "2026-11-02T06:45:00.000Z" });
    expect(res.body.activity.fields).toMatchObject({ startDate: "2026-11-01", endDate: "2026-11-01", startTime: null, endTime: null });
  });

  it("a date in the past is saved with a warning", async () => {
    const res = await create("editor", { startDate: "2026-11-02", endDate: "2026-11-02" });
    expect(res.status).toBe(201);
    expect(res.body.warnings).toEqual(["The start date is in the past.", "The end date is in the past."]);
  });

  it("writes a created history entry listing every set field, with the actor", async () => {
    const id = (await create("editor", { venue: "Sample hall", initiativeIds: [w.ids.initiative] })).body.activity.id as number;
    const [change] = await tdb.db.select().from(activityChanges).where(eq(activityChanges.activityId, id));
    expect(change).toMatchObject({ action: "created", actorId: w.as.editor.id, actorName: "Robin Staff", source: "calendar", contactMinistryKey: "health" });
    const fields = await tdb.db.select().from(activityChangeFields).where(eq(activityChangeFields.changeId, change!.id));
    expect(Object.fromEntries(fields.map((f) => [f.fieldKey, f.newValue]))).toMatchObject({
      title: "Sample activity", venue: "Sample hall", initiatives: "Sample initiative", contact_ministry: "Sample Health", comm_contact: "Robin Staff (HLTH)", city: "Sample City", start: "2026-11-10 09:00",
    });
    expect(fields.every((f) => f.oldValue === null)).toBe(true);
    const history = await call(app, "get", `/api/activities/${id}/changes`, w.as.readOnly.cookie);
    expect(history.status).toBe(200);
    expect(history.body[0]).toMatchObject({ action: "created", actorName: "Robin Staff", source: "calendar" });
    expect(history.body[0].fields).toContainEqual({ key: "venue", label: "Venue", old: null, new: "Sample hall" });
  });

  it("queues activity.created in the same transaction; a confidential activity leaves as its id only (spec addendum §5.4)", async () => {
    const open = (await create("editor", { sharedWithKeys: ["finance"], themeKeys: ["sample-theme"] })).body.activity.id as number;
    const [e] = await outboxOf(tdb.db, open);
    expect(e).toMatchObject({ type: "activity.created", data: { id: open, isConfidential: false, isDeleted: false, title: "Sample activity", contactMinistryKey: "health", sharedMinistryKeys: ["finance"], categoryNames: ["Sample plain category"], cityName: "Sample City", themeKeys: ["sample-theme"] } });
    const secret = (await create("editor", { isConfidential: true, title: "Sample secret" })).body.activity.id as number;
    const [c] = await outboxOf(tdb.db, secret);
    expect(c!.data).toEqual({ id: secret, isConfidential: true, isDeleted: false });
  });

  it("City Other… sends the Other City text as the city name; another city clears Other City", async () => {
    const other = (await create("editor", { cityId: w.city.other, otherCity: "Sample Bay" })).body.activity;
    expect(other.fields.otherCity).toBe("Sample Bay");
    expect((await outboxOf(tdb.db, other.id))[0]!.data.cityName).toBe("Sample Bay");
    expect((await create("editor", { cityId: w.city.sample, otherCity: "Ignored" })).body.activity.fields.otherCity).toBe("");
  });

  it("the freeze refuses a ministry Editor's create at 16:30 BC; an HQ Editor's goes through (spec addendum §7.4)", async () => {
    const frozen = createTestApp(tdb.db, { now: () => new Date("2026-11-03T23:30:00Z") });
    const refused = await call(frozen, "post", "/api/activities", w.as.editor.cookie, validInput(w));
    expect(refused.status).toBe(423);
    expect(refused.body).toEqual({ code: "freeze", error: expect.stringContaining("You cannot make content changes between 4pm-5pm.") });
    expect((await call(frozen, "post", "/api/activities", w.as.hqEditor.cookie, validInput(w, { contactMinistryKey: "finance", commContactId: w.contact.financeEditor }))).status).toBe(201);
  });

  describe("reading", () => {
    let secret: number;
    beforeAll(async () => {
      secret = (await create("editor", { isConfidential: true, title: "Sample confidential" })).body.activity.id as number;
    });

    it("not visible is 404, never 403 (spec addendum §6)", async () => {
      expect((await call(app, "get", `/api/activities/${secret}`, w.as.financeEditor.cookie)).status).toBe(404);
      expect((await call(app, "get", `/api/activities/${secret}`, w.as.hqEditor.cookie)).status).toBe(404);
      expect((await call(app, "get", `/api/activities/${secret}/changes`, w.as.hqEditor.cookie)).status).toBe(404);
      expect((await call(app, "get", "/api/activities/abc", w.as.editor.cookie)).status).toBe(404);
      expect((await call(app, "get", "/api/activities/99999999", w.as.editor.cookie)).status).toBe(404);
    });

    it("HQ Advanced and the owning ministry's Read Only see it; only HQ Editors see the needs-review markup", async () => {
      expect((await call(app, "get", `/api/activities/${secret}`, w.as.hqAdvanced.cookie)).status).toBe(200);
      const ro = await call(app, "get", `/api/activities/${secret}`, w.as.readOnly.cookie);
      expect(ro.status).toBe(200);
      expect(ro.body).toMatchObject({ can: { edit: false, clone: false, delete: false, review: false }, lookAhead: null, needsReview: [] });
      expect(ro.body.fields.lookAhead).toBeUndefined();
    });

    it("a shared-with ministry sees an open activity but may not act on it", async () => {
      const open = (await create("editor", { sharedWithKeys: ["finance"] })).body.activity.id as number;
      const res = await call(app, "get", `/api/activities/${open}`, w.as.financeEditor.cookie);
      expect(res.status).toBe(200);
      expect(res.body.can).toEqual({ edit: false, clone: false, delete: false, review: false });
    });

    it("a deleted activity is 404 to everyone but HQ Administrators", async () => {
      const gone = (await create("editor")).body.activity.id as number;
      await tdb.db.update(activities).set({ deletedAt: new Date("2026-11-03T17:00:00Z") }).where(eq(activities.id, gone));
      expect((await call(app, "get", `/api/activities/${gone}`, w.as.editor.cookie)).status).toBe(404);
      expect((await call(app, "get", `/api/activities/${gone}/changes`, w.as.admin.cookie)).status).toBe(404);
      const hq = await call(app, "get", `/api/activities/${gone}`, w.as.hqAdmin.cookie);
      expect(hq.status).toBe(200);
      expect(hq.body).toMatchObject({ isDeleted: true, can: { edit: false, delete: false } });
    });
  });
});

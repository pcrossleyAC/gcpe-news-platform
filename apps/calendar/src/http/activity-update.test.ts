import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import type { TestDatabase } from "@gcpe/db-kit";
import type { ActivityFields } from "@gcpe/calendar-contract";
import { createCalendarTestDb, createTestApp, FIXED_NOW, projectUser, waitForLockWaiter } from "../../test/helpers";
import { call, historyOf, insertRaw, outboxOf, seedWorld, validInput, type World } from "../../test/world";
import { activities, commContacts, keywords } from "../db/schema";

describe("updating an activity (spec addendum §7.1, §7.5)", () => {
  let tdb: TestDatabase;
  let w: World;
  let clock = FIXED_NOW;
  let app: ReturnType<typeof createTestApp>;
  const make = async (over: Partial<ActivityFields> = {}, who: keyof World["as"] = "editor") => {
    const res = await call(app, "post", "/api/activities", w.as[who].cookie, validInput(w, over));
    expect(res.status).toBe(201);
    return res.body.activity as { id: number; version: number; fields: ActivityFields };
  };
  const save = (who: keyof World["as"], a: { id: number; version: number; fields: ActivityFields }, over: Partial<ActivityFields> = {}, tabId: string | null = null) =>
    call(app, "put", `/api/activities/${a.id}`, w.as[who].cookie, { ...a.fields, ...over, version: a.version, tabId });
  const row = async (id: number) => (await tdb.db.select().from(activities).where(eq(activities.id, id)))[0]!;

  beforeAll(async () => {
    tdb = await createCalendarTestDb();
    app = createTestApp(tdb.db, { now: () => clock });
    w = await seedWorld(app, tdb.db);
  });
  afterAll(() => tdb.drop());

  it("a stale version is 409 with the reload message", async () => {
    const a = await make();
    expect((await save("editor", a, { title: "First" })).status).toBe(200);
    const stale = await save("editor", a, { title: "Second" });
    expect(stale.status).toBe(409);
    expect(stale.body).toEqual({ code: "version_conflict", error: "Someone else changed this activity — reload to see their changes" });
  });

  it("a double-clicked save: one 200, one 409, one history entry", async () => {
    const a = await make();
    const [x, y] = await Promise.all([save("editor", a, { title: "Clicked twice" }), save("editor", a, { title: "Clicked twice" })]);
    expect([x.status, y.status].sort()).toEqual([200, 409]);
    expect((await historyOf(tdb.db, a.id)).filter((h) => h.action === "updated")).toHaveLength(1);
    expect((await outboxOf(tdb.db, a.id)).filter((e) => e.type === "activity.updated")).toHaveLength(1);
  });

  it("a save waits for a concurrent writer's lock, then sees its version", async () => {
    const a = await make();
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const writer = tdb.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`calendar-activity:${a.id}`}))`);
      await tx.update(activities).set({ version: a.version + 1 }).where(eq(activities.id, a.id));
      await held;
    });
    const pending = save("editor", a, { title: "Late" }).then((r) => r);
    await waitForLockWaiter(tdb);
    release();
    await writer;
    expect((await pending).status).toBe(409);
  });

  it("another user's live lock refuses the save (423); once it lapses, the save goes through", async () => {
    clock = FIXED_NOW;
    const a = await make();
    expect((await call(app, "put", `/api/activities/${a.id}/lock`, w.as.admin.cookie, { tabId: "admin-tab" })).status).toBe(200);
    expect((await save("editor", a, { title: "Blocked" })).body).toMatchObject({ code: "locked", error: "Sample Admin is editing this activity (since 11:00)" });
    clock = new Date(FIXED_NOW.getTime() + 15 * 60_000);
    expect((await save("editor", a, { title: "After the lapse" })).status).toBe(200);
    clock = FIXED_NOW;
  });

  it("an idle editor's own lapsed lock doesn't stop the save, and saving releases the saver's lock", async () => {
    const a = await make();
    await call(app, "put", `/api/activities/${a.id}/lock`, w.as.editor.cookie, { tabId: "tab-a" });
    expect((await save("editor", a, { title: "Saved" }, "tab-a")).status).toBe(200);
    expect((await call(app, "get", `/api/activities/${a.id}`, w.as.editor.cookie)).body.lock).toBeNull();
  });

  it("an edit started before the freeze and saved during it is refused; at 17:00 it saves (spec addendum §7.4)", async () => {
    clock = new Date("2026-11-03T22:58:00Z"); // 15:58 BC
    const a = await make();
    await call(app, "put", `/api/activities/${a.id}/lock`, w.as.editor.cookie, { tabId: "tab-a" });
    clock = new Date("2026-11-03T23:01:00Z"); // 16:01 BC
    expect((await save("editor", a, { title: "Too late" }, "tab-a")).body).toMatchObject({ code: "freeze" });
    clock = new Date("2026-11-04T00:00:00Z"); // 17:00 BC
    expect((await save("editor", a, { title: "On time" }, "tab-a")).status).toBe(200);
    clock = FIXED_NOW;
  });

  it("the changes that set nothing leave flags and status alone (spec addendum §7.3)", async () => {
    const a = await make();
    const res = await save("hqEditor", a, {
      contactMinistryKey: "finance", commContactId: w.contact.financeEditor, nrDate: "2026-11-10", nrTime: "08:00", isAtLegislature: true,
      isMilestone: true, sectorKeys: ["sample-sector"], themeKeys: ["sample-theme"], tagKeys: ["sample-tag"], sharedWithKeys: ["health"],
      lookAhead: { hqComments: "Sample summary", hqStatus: "changed", hqSection: "events_and_speeches", longTermOutlook: true },
    });
    expect(res.status).toBe(200);
    expect(await row(a.id)).toMatchObject({ needsReview: [], status: "new" });
  });

  it("a flagged change raises its flag and sets status changed; a second one doesn't repeat a key", async () => {
    const a = await make();
    const once = await save("editor", a, { title: "Renamed" });
    await save("editor", once.body.activity, { title: "Renamed again", venue: "Sample hall" });
    expect(await row(a.id)).toMatchObject({ needsReview: ["title", "venue"], status: "changed" });
  });

  it("swapping one HQ tag for another raises tags (C130)", async () => {
    const a = await make({ keywordNames: ["sample tag", "Sample kept keyword"] });
    await save("editor", a, { keywordNames: ["sample tag", "Swapped in"] });
    expect((await row(a.id)).needsReview).toEqual(["tags"]);
  });

  it("a keyword typed in another case or with spaces reuses the existing one", async () => {
    const a = await make({ keywordNames: [" Sample Tag "] });
    const r = await tdb.db.select().from(keywords).where(sql`lower(${keywords.name}) = 'sample tag'`);
    expect(r).toHaveLength(1);
    expect(a.fields.keywordNames).toEqual(["sample tag"]);
    await save("editor", a, { keywordNames: ["SAMPLE TAG"] });
    expect((await row(a.id)).needsReview).toEqual([]);
  });

  it("an unchanged inactive comm contact is accepted; choosing one is refused", async () => {
    const a = await make();
    await tdb.db.update(commContacts).set({ isActive: false }).where(eq(commContacts.id, w.contact.editorHealth));
    expect((await save("editor", a, { details: "Still fine" })).status).toBe(200);
    const fresh = (await call(app, "get", `/api/activities/${a.id}`, w.as.editor.cookie)).body;
    const refused = await save("editor", fresh, { commContactId: w.contact.retiredHealth });
    expect(refused.status).toBe(422);
    expect(refused.body.errors).toContainEqual({ field: "commContactId", message: "That comm contact is no longer active" });
    await tdb.db.update(commContacts).set({ isActive: true }).where(eq(commContacts.id, w.contact.editorHealth));
  });

  it("a comm contact whose person's account is inactive: kept when unchanged, refused when newly chosen", async () => {
    const person = (n: number, isActive: boolean) => ({ id: `00000000-0000-4000-8000-00000000062${n}`, email: `person${n}@example.test`, displayName: `Sample Person ${n}`, isActive, calendarRole: "Calendar.Editor" as const, organizationKeys: ["health"] });
    await projectUser(app, person(1, true));
    await projectUser(app, person(2, false));
    const kept = (await tdb.db.insert(commContacts).values({ userId: person(1, true).id, ministryKey: "health", rank: 4 }).returning({ id: commContacts.id }))[0]!.id;
    const dormant = (await tdb.db.insert(commContacts).values({ userId: person(2, false).id, ministryKey: "health", rank: 4 }).returning({ id: commContacts.id }))[0]!.id;
    const a = await make({ commContactId: kept });
    await projectUser(app, person(1, false));
    const unchanged = await save("editor", a, { details: "Still fine" });
    expect(unchanged.status).toBe(200);
    expect((await row(a.id)).commContactId).toBe(kept);
    const refused = await save("editor", unchanged.body.activity, { commContactId: dormant });
    expect(refused.status).toBe(422);
    expect(refused.body.errors).toContainEqual({ field: "commContactId", message: "That person's account is inactive" });
    const created = await call(app, "post", "/api/activities", w.as.editor.cookie, validInput(w, { commContactId: dormant }));
    expect(created.status).toBe(422);
    expect(created.body.errors).toContainEqual({ field: "commContactId", message: "That person's account is inactive" });
  });

  it("a comm contact whose person is missing from the Calendar's users: kept when unchanged, refused when newly chosen", async () => {
    const kept = (await tdb.db.insert(commContacts).values({ userId: "00000000-0000-4000-8000-000000000631", ministryKey: "health", rank: 4 }).returning({ id: commContacts.id }))[0]!.id;
    const missing = (await tdb.db.insert(commContacts).values({ userId: "00000000-0000-4000-8000-000000000632", ministryKey: "health", rank: 4 }).returning({ id: commContacts.id }))[0]!.id;
    // An activity that already holds the contact, as an imported one can; it has no category yet.
    const id = await insertRaw(tdb.db, { commContactId: kept, contactMinistryKey: "health" });
    const a = (await call(app, "get", `/api/activities/${id}`, w.as.editor.cookie)).body;
    const unchanged = await save("editor", a, { details: "Still fine", categoryId: w.cat.plain });
    expect(unchanged.status).toBe(200);
    expect((await row(id)).commContactId).toBe(kept);
    const refused = await save("editor", unchanged.body.activity, { commContactId: missing });
    expect(refused.status).toBe(422);
    expect(refused.body.errors).toContainEqual({ field: "commContactId", message: "That person's account is inactive" });
    const created = await call(app, "post", "/api/activities", w.as.editor.cookie, validInput(w, { commContactId: missing }));
    expect(created.status).toBe(422);
    expect(created.body.errors).toContainEqual({ field: "commContactId", message: "That person's account is inactive" });
  });

  it("an HQ Administrator's edit to another ministry's activity leaves 'last updated' alone but moves the version (C129)", async () => {
    const a = await make();
    const before = await row(a.id);
    clock = new Date(FIXED_NOW.getTime() + 60_000);
    const res = await save("hqAdmin", a, { title: "HQ edit" });
    clock = FIXED_NOW;
    expect(res.status).toBe(200);
    expect(await row(a.id)).toMatchObject({ version: 2, lastUpdatedAt: before.lastUpdatedAt, lastUpdatedBy: w.as.editor.id, needsReview: ["title"] });
    expect((await save("editor", a, { title: "Ministry edit" })).status).toBe(409);
  });

  it("limits apply to changed values: an imported over-long title saves unchanged and is refused once edited", async () => {
    const id = await insertRaw(tdb.db, { title: "x".repeat(150), commContactId: w.contact.editorHealth, cityId: w.city.sample });
    await tdb.db.execute(sql`INSERT INTO activity_categories (activity_id, category_id) VALUES (${id}, ${w.cat.plain})`);
    const a = (await call(app, "get", `/api/activities/${id}`, w.as.editor.cookie)).body;
    const ok = await save("editor", a, {});
    expect(ok.status).toBe(200);
    expect((await save("editor", ok.body.activity, { title: `${"x".repeat(150)}y` })).body.errors).toContainEqual({ field: "title", message: "At most 100 characters" });
  });

  it("an imported activity with no comm contact opens, and its next save must choose one (C147)", async () => {
    const id = await insertRaw(tdb.db, { commContactId: null });
    await tdb.db.execute(sql`INSERT INTO activity_categories (activity_id, category_id) VALUES (${id}, ${w.cat.plain})`);
    const a = (await call(app, "get", `/api/activities/${id}`, w.as.editor.cookie)).body;
    expect((await save("editor", a, {})).body.errors).toContainEqual({ field: "commContactId", message: "Choose a comm contact" });
  });

  it("an imported activity's second category stays while the editor's category is unchanged", async () => {
    const id = await insertRaw(tdb.db, { commContactId: w.contact.editorHealth });
    await tdb.db.execute(sql`INSERT INTO activity_categories (activity_id, category_id) VALUES (${id}, ${w.cat.plain}), (${id}, ${w.cat.speech})`);
    const a = (await call(app, "get", `/api/activities/${id}`, w.as.editor.cookie)).body;
    expect((await save("editor", a, { details: "Edited" })).status).toBe(200);
    expect((await row(id)).needsReview).toEqual(["details"]);
  });

  describe("the Look Ahead section (spec addendum §7.6)", () => {
    it("a ministry user's save re-infers it", async () => {
      const a = await make();
      expect((await row(a.id)).hqSection).toBe("in_the_news");
      await save("editor", a, { isIssue: true });
      expect((await row(a.id)).hqSection).toBe("issues_and_reports");
    });
    it("an HQ override survives a ministry user's save", async () => {
      const a = await make();
      expect((await save("hqEditor", a, { lookAhead: { hqComments: "**", hqStatus: null, hqSection: "events_and_speeches", longTermOutlook: false } })).status).toBe(200);
      // The ministry user's own view: it carries no Look Ahead fields to send back.
      const mine = (await call(app, "get", `/api/activities/${a.id}`, w.as.editor.cookie)).body;
      expect((await save("editor", mine, { isIssue: true })).status).toBe(200);
      expect((await row(a.id)).hqSection).toBe("events_and_speeches");
    });
    it("marking it Not for Look Ahead keeps its section", async () => {
      const a = await make();
      await save("editor", a, { isConfidential: true });
      expect((await row(a.id)).hqSection).toBe("in_the_news");
    });
    it("Awareness and the consultations ministry keep their stored section whatever an HQ Editor chooses; Long Term Outlook stays settable", async () => {
      const aware = await insertRaw(tdb.db, { commContactId: w.contact.editorHealth, hqSection: "in_the_news" });
      await tdb.db.execute(sql`INSERT INTO activity_categories (activity_id, category_id) VALUES (${aware}, ${w.cat.awareness})`);
      const [consultContact] = await tdb.db.insert(commContacts).values({ userId: w.as.hqEditor.id, ministryKey: "consult", rank: 4 }).returning({ id: commContacts.id });
      const consult = await insertRaw(tdb.db, { contactMinistryKey: "consult", commContactId: consultContact!.id, hqSection: "events_and_speeches" });
      await tdb.db.execute(sql`INSERT INTO activity_categories (activity_id, category_id) VALUES (${consult}, ${w.cat.plain})`);
      for (const [id, kept] of [[aware, "in_the_news"], [consult, "events_and_speeches"]] as const) {
        const a = (await call(app, "get", `/api/activities/${id}`, w.as.hqEditor.cookie)).body;
        const res = await save("hqEditor", a, { lookAhead: { ...a.fields.lookAhead, hqSection: "issues_and_reports", longTermOutlook: true } });
        expect(res.status).toBe(200);
        expect(await row(id)).toMatchObject({ hqSection: kept, longTermOutlook: true });
      }
    });
  });

  it("refuses: a deleted activity (409), a shared-with ministry (403), an invisible one (404)", async () => {
    const shared = await make({ sharedWithKeys: ["finance"] });
    expect((await save("financeEditor", shared, { title: "Not mine" })).status).toBe(403);
    const secret = await make({ isConfidential: true });
    expect((await save("financeEditor", secret)).status).toBe(404);
    const gone = await make();
    await tdb.db.update(activities).set({ deletedAt: FIXED_NOW }).where(eq(activities.id, gone.id));
    expect((await save("hqAdmin", gone)).body).toMatchObject({ code: "deleted" });
    expect((await save("editor", gone)).status).toBe(404);
  });

  it("queues activity.updated; making it confidential sends only its id from then on", async () => {
    const a = await make();
    await save("editor", a, { isConfidential: true });
    const events = await outboxOf(tdb.db, a.id);
    expect(events.map((e) => e.type)).toEqual(["activity.created", "activity.updated"]);
    expect(events[1]!.data).toEqual({ id: a.id, isConfidential: true, isDeleted: false });
  });

  it("an id past the database's int4, a NUL character or a year outside 1900-2199 is 400, and writes nothing", async () => {
    const a = await make();
    for (const over of [
      { categoryId: 2_147_483_648 }, { cityId: 3_000_000_000 }, { commContactId: 3_000_000_000 }, { commMaterialIds: [3_000_000_000] }, { nrOriginId: 3_000_000_000 },
      { title: "Sample\u0000title" }, { keywordNames: ["Sample\u0000tag"] }, { sectorKeys: ["sample-sector\u0000"] },
      { startDate: "1899-12-31" }, { endDate: "2200-01-01" },
    ]) {
      expect((await save("editor", a, over)).status, JSON.stringify(over)).toBe(400);
    }
    expect((await save("editor", a, {}, "tab\u0000")).status).toBe(400);
    expect((await row(a.id)).version).toBe(a.version);
  });

  it("history lists each changed field with old and new values", async () => {
    const a = await make();
    await save("editor", a, { title: "New title", cityId: w.city.other, otherCity: "Sample Bay" });
    const updated = (await historyOf(tdb.db, a.id)).find((h) => h.action === "updated")!;
    expect(updated.fields).toEqual({ title: ["Sample activity", "New title"], city: ["Sample City", "Other..."], other_city: [null, "Sample Bay"] });
  });
  it("a save that changes nothing still moves the version and queues activity.updated, but writes no history", async () => {
    const a = await make();
    const res = await save("editor", a);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: a.id, activity: { version: 2 }, warnings: [] });
    expect((await historyOf(tdb.db, a.id)).map((h) => h.action)).toEqual(["created"]);
    expect((await outboxOf(tdb.db, a.id)).map((e) => e.type)).toEqual(["activity.created", "activity.updated"]);
    expect(await row(a.id)).toMatchObject({ needsReview: [], status: "new" });
  });

  it("an imported title and summary that clean-up would rewrite raise no flag when saved unchanged", async () => {
    const id = await insertRaw(tdb.db, { title: "Sample \u2018quoted\u2019 title", details: "Sample \u201csummary\u201d\u2026", commContactId: w.contact.editorHealth });
    await tdb.db.execute(sql`INSERT INTO activity_categories (activity_id, category_id) VALUES (${id}, ${w.cat.plain})`);
    const a = (await call(app, "get", `/api/activities/${id}`, w.as.editor.cookie)).body;
    expect((await save("editor", a)).status).toBe(200);
    expect(await row(id)).toMatchObject({ title: "Sample 'quoted' title", details: 'Sample "summary"...', needsReview: [], status: "reviewed" });
    const updated = (await historyOf(tdb.db, id)).find((h) => h.action === "updated")!;
    expect(updated.fields).toMatchObject({ title: ["Sample \u2018quoted\u2019 title", "Sample 'quoted' title"] });
  });

  it("an imported activity whose only change is All Day: status Changed, no flag, and no Start or End in its history", async () => {
    // Already 00:00\u201323:45 BC, so ticking All Day moves neither time (contentFrom's all-day bounds).
    const id = await insertRaw(tdb.db, {
      title: "Sample \u2018quoted\u2019 title", details: "Sample \u201csummary\u201d\u2026", commContactId: w.contact.editorHealth,
      startAt: new Date("2026-11-10T07:00:00Z"), endAt: new Date("2026-11-11T06:45:00Z"), isAllDay: false,
    });
    await tdb.db.execute(sql`INSERT INTO activity_categories (activity_id, category_id) VALUES (${id}, ${w.cat.plain})`);
    const a = (await call(app, "get", `/api/activities/${id}`, w.as.editor.cookie)).body;
    expect((await save("editor", a, { isAllDay: true })).status).toBe(200);
    expect(await row(id)).toMatchObject({
      isAllDay: true, needsReview: [], status: "changed",
      startAt: new Date("2026-11-10T07:00:00Z"), endAt: new Date("2026-11-11T06:45:00Z"),
    });
    const updated = (await historyOf(tdb.db, id)).find((h) => h.action === "updated")!;
    expect(updated.fields).toHaveProperty("is_all_day");
    expect(updated.fields).not.toHaveProperty("start");
    expect(updated.fields).not.toHaveProperty("end");
  });

  it("Look Ahead fields from a user without the fieldset are refused; a fieldset user who leaves them out keeps the stored ones", async () => {
    const a = await make();
    const refused = await save("editor", a, { lookAhead: { hqComments: "Sample", hqStatus: "new", hqSection: "not_on_la", longTermOutlook: true } });
    expect(refused.status).toBe(422);
    expect(refused.body.errors).toContainEqual({ field: "lookAhead", message: "Only HQ can change the Look Ahead fields" });
    const set = await save("hqEditor", a, { lookAhead: { hqComments: "Sample summary", hqStatus: "new", hqSection: "events_and_speeches", longTermOutlook: true } });
    expect(set.status).toBe(200);
    const { lookAhead: _omitted, ...withoutLookAhead } = set.body.activity.fields as ActivityFields;
    expect((await save("hqEditor", { ...set.body.activity, fields: withoutLookAhead }, { isIssue: true })).status).toBe(200);
    expect(await row(a.id)).toMatchObject({ hqComments: "Sample summary", hqStatus: "new", hqSection: "events_and_speeches", longTermOutlook: true });
  });

  it("a save that leaves the activity invisible to its writer succeeds with no activity and a warning, never a 404", async () => {
    const a = await make({ contactMinistryKey: "finance", commContactId: w.contact.financeEditor }, "financeEditor");
    const res = await save("hqEditor", a, { isConfidential: true });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: a.id, activity: null, warnings: ["Saved. You can't view confidential activities for this ministry."] });
    expect(await row(a.id)).toMatchObject({ isConfidential: true, version: 2 });
  });

  it("history records a re-inferred Look Ahead section under its own key", async () => {
    const a = await make();
    await save("editor", a, { isIssue: true });
    const updated = (await historyOf(tdb.db, a.id)).find((h) => h.action === "updated")!;
    expect(updated.fields).toEqual({ is_issue: ["No", "Yes"], hq_section: ["In the News", "Issues & Reports"] });
  });
});

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, inArray, sql } from "drizzle-orm";
import type { TestDatabase } from "@gcpe/db-kit";
import { createCalendarTestDb, createTestApp, FIXED_NOW, projectUser, waitForLockWaiters } from "../../test/helpers";
import { call, historyOf, insertRaw, outboxOf, seedWorld, validInput, type World } from "../../test/world";
import { activities, activitySharedWith, commContacts } from "../db/schema";

describe("Transfer (spec addendum §7.1, C150)", () => {
  let tdb: TestDatabase;
  let w: World;
  let clock = FIXED_NOW;
  let app: ReturnType<typeof createTestApp>;
  let target: number; // an active Health contact other than the editor's
  const preview = (who: keyof World["as"], from: number, to: number) => call(app, "get", `/api/transfer/preview?from=${from}&to=${to}`, w.as[who].cookie);
  const transfer = (who: keyof World["as"], from: number, to: number) => call(app, "post", "/api/transfer", w.as[who].cookie, { from, to });
  // A new Health comm contact for a user who has none there yet (one per user and ministry).
  const fresh = async (userId: string, ministryKey = "health") => (await tdb.db.insert(commContacts).values({ userId, ministryKey, rank: 6 }).returning({ id: commContacts.id }))[0]!.id;
  /** Every `transferred` history insert fails with a check violation while `during` runs. */
  async function failingHistory<T>(during: () => Promise<T>): Promise<T> {
    await tdb.db.execute(sql`CREATE FUNCTION fail_transferred() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'stub failure' USING ERRCODE = '23514'; END $$`);
    await tdb.db.execute(sql`CREATE TRIGGER fail_transferred BEFORE INSERT ON activity_changes FOR EACH ROW WHEN (NEW.action = 'transferred') EXECUTE FUNCTION fail_transferred()`);
    try {
      return await during();
    } finally {
      await tdb.db.execute(sql`DROP TRIGGER fail_transferred ON activity_changes`);
      await tdb.db.execute(sql`DROP FUNCTION fail_transferred()`);
    }
  }

  beforeAll(async () => {
    tdb = await createCalendarTestDb();
    app = createTestApp(tdb.db, { now: () => clock });
    w = await seedWorld(app, tdb.db);
    target = w.contact.adminHealth;
  });
  afterAll(() => tdb.drop());

  it("lists the contacts an Administrator may use: their ministries' for a ministry Administrator, every one for HQ", async () => {
    const mine = await call(app, "get", "/api/transfer/comm-contacts", w.as.admin.cookie);
    expect(mine.status).toBe(200);
    expect(mine.body.map((c: { ministryKey: string }) => c.ministryKey)).toEqual(expect.arrayContaining(["health"]));
    expect(mine.body.some((c: { ministryKey: string }) => c.ministryKey === "finance")).toBe(false);
    expect(mine.body).toContainEqual(expect.objectContaining({ id: w.contact.editorHealth, label: "Robin Staff (HLTH)", isActive: true }));
    expect(mine.body).toContainEqual(expect.objectContaining({ id: w.contact.retiredHealth, isActive: false }));
    const all = await call(app, "get", "/api/transfer/comm-contacts", w.as.hqAdmin.cookie);
    expect(all.body.some((c: { ministryKey: string }) => c.ministryKey === "finance")).toBe(true);
  });

  it("previews and moves every non-deleted activity of A, past ones too; deleted ones stay", async () => {
    const from = w.contact.retiredHealth;
    const live = await insertRaw(tdb.db, { commContactId: from });
    const past = await insertRaw(tdb.db, { commContactId: from, startAt: new Date("2025-01-10T17:00:00Z"), endAt: new Date("2025-01-10T18:00:00Z") });
    const gone = await insertRaw(tdb.db, { commContactId: from, deletedAt: FIXED_NOW });
    const p = await preview("admin", from, target);
    expect(p.status).toBe(200);
    expect(p.body).toMatchObject({ count: 2, from: { id: from }, to: { id: target, ministryName: "Sample Health" } });
    expect((await transfer("admin", from, target)).body).toEqual({ transferred: 2 });
    const rows = await tdb.db.select().from(activities).where(inArray(activities.id, [live, past, gone]));
    expect(rows.find((r) => r.id === live)).toMatchObject({ commContactId: target, contactMinistryKey: "health", version: 2, status: "reviewed", needsReview: [] });
    expect(rows.find((r) => r.id === past)!.commContactId).toBe(target);
    expect(rows.find((r) => r.id === gone)!.commContactId).toBe(from);
  });

  it("writes a transferred entry per activity and queues activity.updated; last updated is untouched", async () => {
    const a = await insertRaw(tdb.db, { commContactId: w.contact.retiredHealth });
    const before = (await tdb.db.select().from(activities).where(eq(activities.id, a)))[0]!;
    await transfer("admin", w.contact.retiredHealth, target);
    expect((await historyOf(tdb.db, a)).at(-1)).toMatchObject({ action: "transferred", actorName: "Sample Admin", fields: { comm_contact: ["Sample Advanced (HLTH)", "Sample Admin (HLTH)"] } });
    expect((await outboxOf(tdb.db, a)).at(-1)!.type).toBe("activity.updated");
    expect((await tdb.db.select().from(activities).where(eq(activities.id, a)))[0]!.lastUpdatedAt).toEqual(before.lastUpdatedAt);
  });

  it("an HQ Administrator moves activities across ministries; the lead ministry becomes B's (by id, not display text)", async () => {
    const a = await insertRaw(tdb.db, { commContactId: w.contact.editorHealth });
    expect((await transfer("hqAdmin", w.contact.editorHealth, w.contact.financeEditor)).status).toBe(200);
    const [row] = await tdb.db.select().from(activities).where(eq(activities.id, a));
    expect(row).toMatchObject({ commContactId: w.contact.financeEditor, contactMinistryKey: "finance" });
    expect((await historyOf(tdb.db, a)).at(-1)!.fields).toMatchObject({ contact_ministry: ["Sample Health", "Sample Finance"] });
    await transfer("hqAdmin", w.contact.financeEditor, w.contact.editorHealth);
  });

  it("moves only what the caller can see", async () => {
    const hidden = await insertRaw(tdb.db, { commContactId: w.contact.editorHealth, contactMinistryKey: "finance", isConfidential: true });
    const p = await preview("admin", w.contact.editorHealth, target);
    const hq = await preview("hqAdmin", w.contact.editorHealth, target);
    expect(hq.body.count).toBe(p.body.count + 1);
    await transfer("admin", w.contact.editorHealth, target);
    expect((await tdb.db.select().from(activities).where(eq(activities.id, hidden)))[0]!.commContactId).toBe(w.contact.editorHealth);
    await transfer("hqAdmin", target, w.contact.editorHealth);
  });

  it("refuses: below Administrator (403), another ministry's contact for a ministry Administrator (404), an inactive target or A = B (422)", async () => {
    expect((await preview("advanced", w.contact.editorHealth, target)).status).toBe(403);
    expect((await transfer("editor", w.contact.editorHealth, target)).status).toBe(403);
    expect((await preview("admin", w.contact.editorHealth, w.contact.financeEditor)).status).toBe(404);
    expect((await transfer("admin", w.contact.editorHealth, w.contact.retiredHealth)).body).toEqual({ error: "Choose an active comm contact to transfer to" });
    expect((await transfer("admin", target, target)).body).toEqual({ error: "Choose two different comm contacts" });
    expect((await call(app, "post", "/api/transfer", w.as.admin.cookie, { from: 1, to: 2, extra: true })).status).toBe(400);
    expect((await call(app, "get", "/api/transfer/preview?from=abc&to=1", w.as.admin.cookie)).status).toBe(400);
    for (const q of ["from=1e3&to=1", "from=0x10&to=1", "from=%201&to=2", "from=&to=1", "from=1&from=2&to=1", "from=0&to=1"]) {
      expect((await call(app, "get", `/api/transfer/preview?${q}`, w.as.admin.cookie)).status, q).toBe(400);
    }
  });

  it("refuses an id too large for the comm contacts table with a 400", async () => {
    expect((await transfer("hqAdmin", 1_000_000_000, target)).status).toBe(400);
    expect((await preview("hqAdmin", w.contact.editorHealth, 1_000_000_000)).status).toBe(400);
  });

  it("reports what committed when a later batch fails, instead of a bare 500", async () => {
    const from = await fresh(w.as.hqEditor.id);
    const ids: number[] = [];
    for (let n = 0; n < 150; n++) ids.push(await insertRaw(tdb.db, { commContactId: from }));
    let calls = 0;
    // Each batch reads the clock once; failing the second call fails the second batch after the first has committed.
    const flaky = createTestApp(tdb.db, {
      now: () => {
        calls++;
        if (calls > 1) throw new Error("stub failure");
        return FIXED_NOW;
      },
    });
    const res = await call(flaky, "post", "/api/transfer", w.as.hqAdmin.cookie, { from, to: target });
    expect(res.status).toBe(207);
    expect(res.body).toEqual({ transferred: 100, failed: true });
    const rows = await tdb.db.select({ commContactId: activities.commContactId }).from(activities).where(inArray(activities.id, ids));
    expect(rows.filter((r) => r.commContactId === target)).toHaveLength(100);
  });

  it("refuses a contact whose ministry can't lead an activity, as a save would, and leaves it out of the To list", async () => {
    const excluded = await fresh(w.as.hqEditor.id, "excluded");
    const retired = await fresh(w.as.hqEditor.id, "retired");
    const a = await insertRaw(tdb.db, { commContactId: w.contact.editorHealth });
    expect((await transfer("hqAdmin", w.contact.editorHealth, excluded)).body).toEqual({ error: "That ministry can't lead an activity" });
    expect((await preview("hqAdmin", w.contact.editorHealth, excluded)).status).toBe(422);
    expect((await transfer("hqAdmin", w.contact.editorHealth, retired)).body).toEqual({ error: "That ministry is no longer active" });
    expect((await preview("hqAdmin", w.contact.editorHealth, retired)).status).toBe(422);
    expect((await tdb.db.select().from(activities).where(eq(activities.id, a)))[0]).toMatchObject({ commContactId: w.contact.editorHealth, contactMinistryKey: "health" });
    const list = (await call(app, "get", "/api/transfer/comm-contacts", w.as.hqAdmin.cookie)).body as { id: number; canReceive: boolean }[];
    expect(list.find((c) => c.id === excluded)).toMatchObject({ canReceive: false });
    expect(list.find((c) => c.id === retired)).toMatchObject({ canReceive: false });
    expect(list.find((c) => c.id === w.contact.retiredHealth)).toMatchObject({ canReceive: false });
    expect(list.find((c) => c.id === target)).toMatchObject({ canReceive: true });
    // They stay usable as From.
    const b = await insertRaw(tdb.db, { commContactId: excluded, contactMinistryKey: "excluded" });
    expect((await transfer("hqAdmin", excluded, target)).body).toEqual({ transferred: 1 });
    expect((await tdb.db.select().from(activities).where(eq(activities.id, b)))[0]!.commContactId).toBe(target);
  });

  it("refuses a contact whose person's account is inactive in the Calendar, lists it as unable to receive, and keeps it usable as From", async () => {
    const DORMANT = "00000000-0000-4000-8000-000000000611";
    await projectUser(app, { id: DORMANT, email: "dormant@example.test", displayName: "Sample Dormant", isActive: false, calendarRole: "Calendar.Editor", organizationKeys: ["health"] });
    const dormant = await fresh(DORMANT);
    const a = await insertRaw(tdb.db, { commContactId: w.contact.editorHealth });
    expect((await preview("admin", w.contact.editorHealth, dormant)).status).toBe(422);
    expect((await preview("admin", w.contact.editorHealth, dormant)).body).toEqual({ error: "That person's account is inactive" });
    expect((await transfer("admin", w.contact.editorHealth, dormant)).body).toEqual({ error: "That person's account is inactive" });
    expect((await tdb.db.select().from(activities).where(eq(activities.id, a)))[0]!.commContactId).toBe(w.contact.editorHealth);
    const list = (await call(app, "get", "/api/transfer/comm-contacts", w.as.admin.cookie)).body as { id: number; isActive: boolean; userIsActive: boolean; canReceive: boolean }[];
    expect(list.find((c) => c.id === dormant)).toMatchObject({ isActive: true, userIsActive: false, canReceive: false });
    expect(list.find((c) => c.id === target)).toMatchObject({ userIsActive: true, canReceive: true });
    const b = await insertRaw(tdb.db, { commContactId: dormant });
    expect((await transfer("admin", dormant, target)).body).toEqual({ transferred: 1 });
    expect((await tdb.db.select().from(activities).where(eq(activities.id, b)))[0]!.commContactId).toBe(target);
  });

  it("refuses a contact whose person is missing from the Calendar's users, and keeps it usable as From", async () => {
    const missing = (await tdb.db.insert(commContacts).values({ userId: "00000000-0000-4000-8000-000000000998", ministryKey: "health", rank: 6 }).returning({ id: commContacts.id }))[0]!.id;
    const a = await insertRaw(tdb.db, { commContactId: w.contact.editorHealth });
    expect((await preview("admin", w.contact.editorHealth, missing)).status).toBe(422);
    expect((await transfer("admin", w.contact.editorHealth, missing)).body).toEqual({ error: "That person's account is inactive" });
    expect((await tdb.db.select().from(activities).where(eq(activities.id, a)))[0]!.commContactId).toBe(w.contact.editorHealth);
    const list = (await call(app, "get", "/api/transfer/comm-contacts", w.as.admin.cookie)).body as { id: number; userIsActive: boolean; canReceive: boolean }[];
    expect(list.find((c) => c.id === missing)).toMatchObject({ userIsActive: false, canReceive: false });
    const b = await insertRaw(tdb.db, { commContactId: missing });
    expect((await transfer("admin", missing, target)).body).toEqual({ transferred: 1 });
    expect((await tdb.db.select().from(activities).where(eq(activities.id, b)))[0]!.commContactId).toBe(target);
  });

  it("labels a contact whose user is missing as the history does", async () => {
    const ghost = (await tdb.db.insert(commContacts).values({ userId: "00000000-0000-4000-8000-000000000999", ministryKey: "health", rank: 6 }).returning({ id: commContacts.id }))[0]!.id;
    const list = (await call(app, "get", "/api/transfer/comm-contacts", w.as.admin.cookie)).body as { id: number; label: string }[];
    expect(list.find((c) => c.id === ghost)!.label).toBe("Unknown (HLTH)");
    const a = await insertRaw(tdb.db, { commContactId: ghost });
    await transfer("admin", ghost, target);
    expect((await historyOf(tdb.db, a)).at(-1)!.fields).toMatchObject({ comm_contact: ["Unknown (HLTH)", "Sample Admin (HLTH)"] });
  });

  it("a ministry Administrator doesn't move another ministry's activity shared with theirs", async () => {
    const count = async (who: keyof World["as"]) => (await preview(who, w.contact.editorHealth, target)).body.count as number;
    const [mine, hq] = [await count("admin"), await count("hqAdmin")];
    const a = await insertRaw(tdb.db, { commContactId: w.contact.editorHealth, contactMinistryKey: "finance" });
    await tdb.db.insert(activitySharedWith).values({ activityId: a, ministryKey: "health" });
    expect(await count("admin")).toBe(mine);
    expect(await count("hqAdmin")).toBe(hq + 1);
    await transfer("admin", w.contact.editorHealth, target);
    expect((await tdb.db.select().from(activities).where(eq(activities.id, a)))[0]).toMatchObject({ commContactId: w.contact.editorHealth, contactMinistryKey: "finance" });
    await transfer("admin", target, w.contact.editorHealth);
    await tdb.db.update(activities).set({ deletedAt: FIXED_NOW }).where(eq(activities.id, a));
  });

  it("a failure in the first batch, before anything committed, is mapped as any other error", async () => {
    const from = await fresh(w.as.hqAdvanced.id);
    const a = await insertRaw(tdb.db, { commContactId: from });
    const res = await failingHistory(() => transfer("admin", from, target));
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: "conflict" });
    expect((await tdb.db.select().from(activities).where(eq(activities.id, a)))[0]!.commContactId).toBe(from);
  });

  it("isn't frozen (spec addendum §7.4)", async () => {
    clock = new Date("2026-11-03T23:30:00Z");
    expect((await transfer("admin", w.contact.editorHealth, target)).status).toBe(200);
    clock = FIXED_NOW;
  });

  it("an open editor's next save is 409", async () => {
    const a = (await call(app, "post", "/api/activities", w.as.editor.cookie, validInput(w))).body.activity;
    await call(app, "put", `/api/activities/${a.id}/lock`, w.as.editor.cookie, { tabId: "tab-a" });
    await transfer("admin", w.contact.editorHealth, target);
    const res = await call(app, "put", `/api/activities/${a.id}`, w.as.editor.cookie, { ...a.fields, version: a.version, tabId: "tab-a" });
    expect(res.body).toMatchObject({ code: "version_conflict" });
    await transfer("admin", target, w.contact.editorHealth);
  });

  it("the run moves what is there when it runs, and says how many", async () => {
    const from = await fresh(w.as.readOnly.id);
    await insertRaw(tdb.db, { commContactId: from });
    expect((await preview("admin", from, target)).body.count).toBe(1);
    await insertRaw(tdb.db, { commContactId: from });
    expect((await transfer("admin", from, target)).body).toEqual({ transferred: 2 });
  });

  it("a target that can't receive by the next batch stops the run there, and says what moved", async () => {
    // A different ministry than the earlier fresh(hqAdvanced) above: that pair is already taken.
    const from = await fresh(w.as.hqAdvanced.id, "finance");
    const to = await fresh(w.as.hqAdmin.id);
    for (let n = 0; n < 150; n++) await insertRaw(tdb.db, { commContactId: from });
    // Retires the target as soon as it holds 100 activities: inside the first batch's transaction.
    await tdb.db.execute(sql`CREATE FUNCTION retire_target() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF (SELECT count(*) FROM activities WHERE comm_contact_id = NEW.comm_contact_id) >= 100 THEN
        UPDATE comm_contacts SET is_active = false WHERE id = NEW.comm_contact_id;
      END IF;
      RETURN NEW;
    END $$`);
    await tdb.db.execute(sql`CREATE TRIGGER retire_target AFTER UPDATE OF comm_contact_id ON activities FOR EACH ROW EXECUTE FUNCTION retire_target()`);
    try {
      const res = await transfer("hqAdmin", from, to);
      expect(res.status).toBe(207);
      expect(res.body).toEqual({ transferred: 100, failed: true });
    } finally {
      await tdb.db.execute(sql`DROP TRIGGER retire_target ON activities`);
      await tdb.db.execute(sql`DROP FUNCTION retire_target()`);
    }
    const moved = await tdb.db.select({ id: activities.id }).from(activities).where(eq(activities.commContactId, to));
    expect(moved).toHaveLength(100);
  });

  it("two transfers at once move each activity once; 150 activities cross batches", async () => {
    const from = await fresh(w.as.hqReadOnly.id);
    const ids: number[] = [];
    for (let n = 0; n < 150; n++) ids.push(await insertRaw(tdb.db, { commContactId: from }));
    // Hold the first activity's lock until both runs have read their candidates and are waiting on it.
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let locked!: () => void;
    const isLocked = new Promise<void>((r) => (locked = r));
    const blocker = tdb.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`calendar-activity:${ids[0]}`}))`);
      locked();
      await held;
    });
    await isLocked;
    const runs = Promise.all([transfer("admin", from, target), transfer("hqAdmin", from, target)]);
    await waitForLockWaiters(tdb, 2);
    release();
    await blocker;
    const [x, y] = await runs;
    expect([x.status, y.status]).toEqual([200, 200]);
    expect(x.body.transferred + y.body.transferred).toBe(150);
    const rows = await tdb.db.select({ commContactId: activities.commContactId, version: activities.version }).from(activities).where(inArray(activities.id, ids));
    expect(rows.every((r) => r.commContactId === target && r.version === 2)).toBe(true);
    const counts = await tdb.pool.query<{ n: number }>("SELECT count(*)::int AS n FROM activity_changes WHERE action = 'transferred' AND activity_id = ANY($1) GROUP BY activity_id", [ids]);
    expect(counts.rows).toHaveLength(150);
    expect(counts.rows.every((r) => r.n === 1)).toBe(true);
  });
});

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import type { TestDatabase } from "@gcpe/db-kit";
import { createCalendarTestDb, createTestApp, FIXED_NOW } from "../../test/helpers";
import { call, historyOf, insertRaw, outboxOf, seedWorld, validInput, type World } from "../../test/world";
import { activities, commContacts } from "../db/schema";

describe("Transfer (spec addendum §7.1, C150)", () => {
  let tdb: TestDatabase;
  let w: World;
  let clock = FIXED_NOW;
  let app: ReturnType<typeof createTestApp>;
  let target: number; // an active Health contact other than the editor's
  const preview = (who: keyof World["as"], from: number, to: number) => call(app, "get", `/api/transfer/preview?from=${from}&to=${to}`, w.as[who].cookie);
  const transfer = (who: keyof World["as"], from: number, to: number) => call(app, "post", "/api/transfer", w.as[who].cookie, { from, to });
  // A new Health comm contact for a user who has none there yet (one per user and ministry).
  const fresh = async (userId: string) => (await tdb.db.insert(commContacts).values({ userId, ministryKey: "health", rank: 6 }).returning({ id: commContacts.id }))[0]!.id;

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

  it("two transfers at once move each activity once; 150 activities cross batches", async () => {
    const from = await fresh(w.as.hqReadOnly.id);
    const ids: number[] = [];
    for (let n = 0; n < 150; n++) ids.push(await insertRaw(tdb.db, { commContactId: from }));
    const [x, y] = await Promise.all([transfer("admin", from, target), transfer("hqAdmin", from, target)]);
    expect(x.body.transferred + y.body.transferred).toBe(150);
    for (const id of ids.slice(0, 3)) expect((await historyOf(tdb.db, id)).filter((h) => h.action === "transferred")).toHaveLength(1);
  });
});

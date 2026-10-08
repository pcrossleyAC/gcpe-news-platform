import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { TestDatabase } from "@gcpe/db-kit";
import { createCalendarTestDb, createTestApp, FIXED_NOW } from "../../test/helpers";
import { call, seedWorld, validInput, type World } from "../../test/world";
import { activities, activityLocks } from "../db/schema";
import { sweepLocks } from "../activities/locks";

const minutes = (n: number) => new Date(FIXED_NOW.getTime() + n * 60_000);

describe("edit locks (spec addendum §7.5)", () => {
  let tdb: TestDatabase;
  let w: World;
  let clock = FIXED_NOW;
  let app: ReturnType<typeof createTestApp>;
  let id: number;
  const lock = (who: keyof World["as"], tabId: string, takeOver?: boolean) => call(app, "put", `/api/activities/${id}/lock`, w.as[who].cookie, { tabId, ...(takeOver ? { takeOver } : {}) });
  const release = (who: keyof World["as"], tabId: string) => call(app, "post", `/api/activities/${id}/lock/release`, w.as[who].cookie, { tabId });

  beforeAll(async () => {
    tdb = await createCalendarTestDb();
    app = createTestApp(tdb.db, { now: () => clock });
    w = await seedWorld(app, tdb.db);
  });
  beforeEach(async () => {
    clock = FIXED_NOW;
    id = (await call(app, "post", "/api/activities", w.as.editor.cookie, validInput(w))).body.activity.id;
  });
  afterAll(() => tdb.drop());

  it("the first taker gets it; the view shows it as theirs", async () => {
    const res = await lock("editor", "tab-a");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ holderName: "Robin Staff", mine: true, tabId: "tab-a" });
    expect((await call(app, "get", `/api/activities/${id}`, w.as.editor.cookie)).body.lock).toMatchObject({ holderName: "Robin Staff", mine: true, tabId: "tab-a" });
  });

  it("someone else gets 423 naming the holder and since when, in BC time", async () => {
    await lock("editor", "tab-a");
    const res = await lock("admin", "tab-b");
    expect(res.status).toBe(423);
    expect(res.body).toEqual({ code: "locked", error: "Robin Staff is editing this activity (since 11:00)", holder: { displayName: "Robin Staff", since: FIXED_NOW.toISOString() } });
    expect((await call(app, "get", `/api/activities/${id}`, w.as.admin.cookie)).body.lock).toMatchObject({ holderName: "Robin Staff", mine: false, tabId: null });
  });

  it("the same user in another tab is offered Continue here, which moves the lock", async () => {
    await lock("editor", "tab-a");
    expect((await lock("editor", "tab-b")).body).toMatchObject({ code: "locked_elsewhere" });
    expect((await lock("editor", "tab-b", true)).status).toBe(200);
    expect((await tdb.db.select().from(activityLocks).where(eq(activityLocks.activityId, id)))[0]).toMatchObject({ tabId: "tab-b", acquiredAt: FIXED_NOW });
  });

  it("only the holder's own tab releases it (legacy's cancel deleted anyone's lock)", async () => {
    await lock("editor", "tab-a");
    expect((await release("admin", "tab-a")).status).toBe(204);
    expect((await release("editor", "tab-z")).status).toBe(204);
    expect((await lock("admin", "tab-b")).status).toBe(423);
    await release("editor", "tab-a");
    expect((await lock("admin", "tab-b")).status).toBe(200);
  });

  it("Continue here never takes another user's live lock", async () => {
    await lock("editor", "tab-a");
    const res = await lock("admin", "tab-b", true);
    expect(res.status).toBe(423);
    expect(res.body).toMatchObject({ code: "locked" });
    expect((await tdb.db.select().from(activityLocks).where(eq(activityLocks.activityId, id)))[0]).toMatchObject({ userId: w.as.editor.id, tabId: "tab-a" });
  });

  it("lapses after 15 idle minutes; a heartbeat keeps it live", async () => {
    await lock("editor", "tab-a");
    clock = minutes(10);
    expect((await lock("editor", "tab-a")).status).toBe(200);
    clock = minutes(24);
    expect((await lock("admin", "tab-b")).status).toBe(423);
    clock = minutes(25);
    expect((await lock("admin", "tab-b")).status).toBe(200);
  });

  it("the sweep deletes lapsed locks and leaves live ones", async () => {
    await tdb.db.delete(activityLocks);
    await lock("editor", "tab-a");
    const other = (await call(app, "post", "/api/activities", w.as.editor.cookie, validInput(w))).body.activity.id as number;
    clock = minutes(10);
    await call(app, "put", `/api/activities/${other}/lock`, w.as.editor.cookie, { tabId: "tab-c" });
    expect(await sweepLocks(tdb.db, () => minutes(16))).toEqual({ deleted: 1 });
    const left = await tdb.db.select().from(activityLocks);
    expect(left.map((l) => l.activityId)).toContain(other);
    expect(left.map((l) => l.activityId)).not.toContain(id);
  });

  it("is a content write: frozen for a ministry Editor, not for an HQ Editor (spec addendum §7.4)", async () => {
    clock = new Date("2026-11-03T23:30:00Z");
    expect((await lock("editor", "tab-a")).body).toMatchObject({ code: "freeze" });
    expect((await lock("hqEditor", "tab-h")).status).toBe(200);
  });

  it("needs edit rights on a live, visible activity", async () => {
    expect((await lock("readOnly", "tab-r")).status).toBe(403);
    expect((await lock("financeEditor", "tab-f")).status).toBe(404);
    await tdb.db.update(activities).set({ deletedAt: FIXED_NOW }).where(eq(activities.id, id));
    expect((await lock("hqAdmin", "tab-q")).body).toMatchObject({ code: "deleted" });
  });

  it("two people taking it at once: exactly one wins", async () => {
    const [a, b] = await Promise.all([lock("editor", "tab-a"), lock("admin", "tab-b")]);
    expect([a.status, b.status].sort()).toEqual([200, 423]);
  });

  it("a malformed body is 400", async () => {
    expect((await call(app, "put", `/api/activities/${id}/lock`, w.as.editor.cookie, { tabId: "" })).status).toBe(400);
    expect((await call(app, "put", `/api/activities/${id}/lock`, w.as.editor.cookie, { tabId: "a", extra: 1 })).status).toBe(400);
    expect((await lock("editor", "tab\u0000")).status).toBe(400);
    expect((await release("editor", "tab\u0000")).status).toBe(400);
  });
});

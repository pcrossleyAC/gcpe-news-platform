import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import type { TestDatabase } from "@gcpe/db-kit";
import { createCalendarTestDb, createTestApp } from "../../test/helpers";
import { call, insertRaw, seedWorld, type World } from "../../test/world";
import { favourites, userProfiles } from "../db/schema";

describe("list preferences and the watchlist (spec addendum §8.1)", () => {
  let tdb: TestDatabase;
  let w: World;
  let app: ReturnType<typeof createTestApp>;
  let frozen: ReturnType<typeof createTestApp>;

  beforeAll(async () => {
    tdb = await createCalendarTestDb();
    app = createTestApp(tdb.db);
    // 16:30 BC: inside the freeze, which doesn't apply to either.
    frozen = createTestApp(tdb.db, { now: () => new Date("2026-11-02T23:30:00Z") });
    w = await seedWorld(app, tdb.db);
  });
  afterAll(() => tdb.drop());

  it("defaults to legacy's: Show All, with HQ Tags, Ministry, Status and Translations hidden", async () => {
    const res = await call(app, "get", "/api/list/preferences", w.as.editor.cookie);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ display: "all", hiddenColumns: ["keywords", "ministry", "status", "translations"] });
  });

  it("a contact-details profile with no list choice still gets the defaults", async () => {
    await tdb.db.insert(userProfiles).values({ userId: w.as.admin.id, phone: "250-555-0102" });
    expect((await call(app, "get", "/api/list/preferences", w.as.admin.cookie)).body.hiddenColumns).toEqual(["keywords", "ministry", "status", "translations"]);
  });

  it("saves both together, during the freeze too, and keeps the profile's contact details", async () => {
    await tdb.db.insert(userProfiles).values({ userId: w.as.readOnly.id, phone: "250-555-0103" });
    const res = await call(frozen, "put", "/api/list/preferences", w.as.readOnly.cookie, { display: "my_watchlist", hiddenColumns: ["translations", "city"] });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ display: "my_watchlist", hiddenColumns: ["city", "translations"] });
    expect((await call(app, "get", "/api/list/preferences", w.as.readOnly.cookie)).body).toEqual({ display: "my_watchlist", hiddenColumns: ["city", "translations"] });
    const [p] = await tdb.db.select().from(userProfiles).where(eq(userProfiles.userId, w.as.readOnly.id));
    expect(p!.phone).toBe("250-555-0103");
    // Showing every column is a choice too.
    expect((await call(app, "put", "/api/list/preferences", w.as.readOnly.cookie, { display: "all", hiddenColumns: [] })).body).toEqual({ display: "all", hiddenColumns: [] });
  });

  it("refuses hiding the Activity Id column, a repeat, an unknown column or display, and extra keys", async () => {
    for (const body of [
      { display: "all", hiddenColumns: ["activity"] }, { display: "all", hiddenColumns: ["city", "city"] }, { display: "all", hiddenColumns: ["colour"] },
      { display: "everything", hiddenColumns: [] }, { display: "all", hiddenColumns: [], extra: 1 }, { display: "all" },
    ]) expect((await call(app, "put", "/api/list/preferences", w.as.editor.cookie, body)).status, JSON.stringify(body)).toBe(400);
  });

  it("watching needs a visible activity; it is idempotent and not frozen; unwatching never 404s", async () => {
    const own = await insertRaw(tdb.db, {});
    const secret = await insertRaw(tdb.db, { contactMinistryKey: "finance", isConfidential: true });
    const watch = (id: number | string, method: "put" | "delete" = "put", via = app) => call(via, method, `/api/activities/${id}/watch`, w.as.editor.cookie);
    expect((await watch(own, "put", frozen)).status).toBe(204);
    expect((await watch(own)).status).toBe(204);
    expect(await tdb.db.select().from(favourites).where(and(eq(favourites.userId, w.as.editor.id), eq(favourites.activityId, own)))).toHaveLength(1);
    expect((await watch(secret)).status).toBe(404);
    expect((await watch("abc")).status).toBe(404);
    expect((await watch("9999999999")).status).toBe(404);
    expect(await tdb.db.select().from(favourites).where(eq(favourites.activityId, secret))).toHaveLength(0);
    expect((await watch(own, "delete")).status).toBe(204);
    expect((await watch(secret, "delete")).status).toBe(204);
    expect(await tdb.db.select().from(favourites).where(eq(favourites.activityId, own))).toHaveLength(0);
    expect((await call(app, "put", `/api/activities/${own}/watch`, w.as.editor.cookie, { extra: 1 })).status).toBe(400);
  });
});

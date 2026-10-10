import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import type { TestDatabase } from "@gcpe/db-kit";
import { EMPTY_LIST_FILTER } from "@gcpe/calendar-contract";
import { createCalendarTestDb, createTestApp } from "../../test/helpers";
import { call, insertRaw, seedWorld, type World } from "../../test/world";
import { activityCategories, savedFilters } from "../db/schema";

describe("saved filters, \"My Queries\" (spec addendum §8.1, C141)", () => {
  let tdb: TestDatabase;
  let w: World;
  let app: ReturnType<typeof createTestApp>;
  let frozen: ReturnType<typeof createTestApp>;
  const user = (who: keyof World["as"]) => ({
    list: () => call(app, "get", "/api/saved-filters", w.as[who].cookie),
    create: (body: object, via = app) => call(via, "post", "/api/saved-filters", w.as[who].cookie, body),
    rename: (id: number | string, name: string) => call(app, "put", `/api/saved-filters/${id}`, w.as[who].cookie, { name }),
    remove: (id: number | string) => call(app, "delete", `/api/saved-filters/${id}`, w.as[who].cookie),
    order: (ids: number[]) => call(app, "put", "/api/saved-filters/order", w.as[who].cookie, { ids }),
  });

  beforeAll(async () => {
    tdb = await createCalendarTestDb();
    app = createTestApp(tdb.db);
    frozen = createTestApp(tdb.db, { now: () => new Date("2026-11-02T23:30:00Z") });
    w = await seedWorld(app, tdb.db);
  });
  afterAll(() => tdb.drop());

  it("saves (during the freeze too), lists in order, renames, reorders and deletes; delete keeps the row, inactive", async () => {
    const me = user("editor");
    const a = await me.create({ name: " Sample one ", filter: { categoryId: w.cat.event } }, frozen);
    expect(a.status).toBe(201);
    expect(a.body).toEqual({ id: expect.any(Number), name: "Sample one", sortOrder: 1, filter: { ...EMPTY_LIST_FILTER, categoryId: w.cat.event } });
    const b = (await me.create({ name: "Sample two", filter: {} })).body;
    expect((await me.list()).body.map((f: { name: string }) => f.name)).toEqual(["Sample one", "Sample two"]);
    expect((await me.rename(b.id, "Sample second")).body).toMatchObject({ id: b.id, name: "Sample second" });
    expect((await me.order([b.id, a.body.id])).body.map((f: { id: number }) => f.id)).toEqual([b.id, a.body.id]);
    expect((await me.remove(a.body.id)).status).toBe(204);
    expect((await me.list()).body.map((f: { id: number }) => f.id)).toEqual([b.id]);
    const [row] = await tdb.db.select().from(savedFilters).where(eq(savedFilters.id, a.body.id));
    expect(row!.isActive).toBe(false);
  });

  it("is owner only: another user's query is 404 to rename or delete and absent from their list", async () => {
    const mine = (await user("admin").create({ name: "Sample private", filter: {} })).body;
    expect((await user("editor").rename(mine.id, "Taken")).status).toBe(404);
    expect((await user("editor").remove(mine.id)).status).toBe(404);
    expect((await user("editor").list()).body.map((f: { id: number }) => f.id)).not.toContain(mine.id);
    expect((await user("admin").list()).body.map((f: { name: string }) => f.name)).toContain("Sample private");
  });

  it("reorder names exactly the owner's active queries, or it is 409", async () => {
    const me = user("readOnly");
    const x = (await me.create({ name: "Sample x", filter: {} })).body;
    const y = (await me.create({ name: "Sample y", filter: {} })).body;
    const other = (await user("hqEditor").create({ name: "Sample other", filter: {} })).body;
    expect((await me.order([x.id])).status).toBe(409);
    expect((await me.order([x.id, y.id, other.id])).status).toBe(409);
    expect((await me.order([y.id, x.id])).status).toBe(200);
  });

  it("a deleted (inactive) query is 404 to rename or delete again, and 409 in a reorder", async () => {
    const me = user("financeEditor");
    const kept = (await me.create({ name: "Sample kept", filter: {} })).body;
    const gone = (await me.create({ name: "Sample gone", filter: {} })).body;
    expect((await me.remove(gone.id)).status).toBe(204);
    expect((await me.rename(gone.id, "Sample back")).status).toBe(404);
    expect((await me.remove(gone.id)).status).toBe(404);
    expect((await me.order([kept.id, gone.id])).status).toBe(409);
    expect((await me.order([kept.id])).status).toBe(200);
    const [row] = await tdb.db.select().from(savedFilters).where(eq(savedFilters.id, gone.id));
    expect(row).toMatchObject({ name: "Sample gone", isActive: false });
  });

  it("refuses a blank or over-long name, a bad filter, an unknown key, and bad ids", async () => {
    const me = user("financeEditor");
    for (const body of [{ name: "  ", filter: {} }, { name: "x".repeat(201), filter: {} }, { name: "Sample", filter: { categoryId: -1 } }, { name: "Sample", filter: {}, extra: 1 }, { name: "Sample" }]) {
      expect((await me.create(body)).status, JSON.stringify(body)).toBe(400);
    }
    expect((await me.rename("abc", "Sample")).status).toBe(404);
    expect((await me.rename("9999999999", "Sample")).status).toBe(404);
    expect((await me.order([2_147_483_648])).status).toBe(400);
  });

  it("keeps at most 200 active queries per owner", async () => {
    await tdb.db.insert(savedFilters).values(Array.from({ length: 200 }, (_, n) => ({ ownerId: w.as.hqAdvanced.id, name: `Sample ${n}`, filter: EMPTY_LIST_FILTER, sortOrder: n + 1 })));
    const res = await user("hqAdvanced").create({ name: "Sample 201", filter: {} });
    expect(res.status).toBe(422);
    expect(res.body.error).toMatch(/200/);
  });

  it("a saved filter naming a deactivated category still applies; an unreadable one is null, not a 500", async () => {
    const saved = (await user("hqAdmin").create({ name: "Sample retired", filter: { categoryId: w.cat.retired, from: "2045-01-01", to: "2045-12-31" } })).body;
    const id = await insertRaw(tdb.db, { startAt: new Date("2045-01-10T17:00:00Z"), endAt: new Date("2045-01-10T18:00:00Z") });
    await tdb.db.insert(activityCategories).values({ activityId: id, categoryId: w.cat.retired });
    const q = encodeURIComponent(JSON.stringify({ filter: saved.filter }));
    expect((await call(app, "get", `/api/list?q=${q}`, w.as.hqAdmin.cookie)).body.rows.map((r: { id: number }) => r.id)).toEqual([id]);
    const broken = (await user("hqAdmin").create({ name: "Sample broken", filter: {} })).body;
    await tdb.db.execute(sql`UPDATE saved_filters SET filter = '{"colour":"blue"}'::jsonb WHERE id = ${broken.id}`);
    const list = await user("hqAdmin").list();
    expect(list.status).toBe(200);
    expect(list.body.find((f: { id: number }) => f.id === broken.id)).toEqual({ id: broken.id, name: "Sample broken", sortOrder: expect.any(Number), filter: null });
  });
});

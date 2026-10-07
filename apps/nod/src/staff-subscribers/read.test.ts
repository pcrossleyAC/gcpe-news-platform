import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import type { TestDatabase } from "@gcpe/db-kit";
import { createNodTestDb } from "../../test/helpers";
import { subscriberHistory, subscribers, subscriptions } from "../db/schema";
import { escapeLike, getSubscriberDetail, listHistory, listOptions, PAGE_SIZE, searchSubscribers } from "./read";

describe("staff subscriber reads", () => {
  let tdb: TestDatabase;
  const add = async (email: string, over: Partial<typeof subscribers.$inferInsert> = {}) =>
    (await tdb.db.insert(subscribers).values({ email, status: "active", ...over }).returning())[0]!;

  beforeAll(async () => {
    tdb = await createNodTestDb();
    await tdb.db.execute(sql`
      INSERT INTO list_categories (key, name, enabled, sort_order) VALUES ('ministries','Ministries',true,1),('sectors','Sectors',false,2),('media-distribution-lists','Media',true,9)
      ON CONFLICT (key) DO UPDATE SET enabled = EXCLUDED.enabled, sort_order = EXCLUDED.sort_order;
      INSERT INTO lists (list_key, category, key, name, active, sort_order) VALUES
        ('ministries:health','ministries','health','Health',true,1),
        ('ministries:old','ministries','old','Old ministry',false,2),
        ('sectors:energy','sectors','energy','Energy',true,1),
        ('media-distribution-lists:budget','media-distribution-lists','budget','Budget',true,1)`);
  });
  afterAll(async () => tdb.drop());
  beforeEach(async () => {
    await tdb.db.execute(sql`DELETE FROM subscribers`);
  });

  it("search is a case-insensitive, trimmed substring match, ordered by email", async () => {
    await add("zed.pat@example.test");
    await add("Pat@Example.test");
    await add("lee@example.test");
    const r = await searchSubscribers(tdb.db, { q: "  PAT@ ", status: "all", page: 1 });
    expect(r.items.map((s) => s.email)).toEqual(["Pat@Example.test", "zed.pat@example.test"]);
    expect(r.total).toBe(2);
  });

  it("search treats wildcards literally", async () => {
    await add("pat_smith@example.test");
    await add("patxsmith@example.test");
    await add("back\\slash@example.test");
    expect((await searchSubscribers(tdb.db, { q: "pat_smith", status: "all", page: 1 })).items.map((s) => s.email)).toEqual(["pat_smith@example.test"]);
    expect((await searchSubscribers(tdb.db, { q: "%", status: "all", page: 1 })).total).toBe(0);
    expect((await searchSubscribers(tdb.db, { q: "k\\s", status: "all", page: 1 })).total).toBe(1);
    expect(escapeLike("a%b_c\\d")).toBe("a\\%b\\_c\\\\d");
  });

  it("filters by status, including disabled and deleted", async () => {
    await add("a@example.test");
    await add("b@example.test", { status: "disabled" });
    await add("c@example.test", { status: "deleted" });
    expect((await searchSubscribers(tdb.db, { q: "", status: "disabled", page: 1 })).items.map((s) => s.email)).toEqual(["b@example.test"]);
    expect((await searchSubscribers(tdb.db, { q: "", status: "all", page: 1 })).total).toBe(3);
  });

  it("pages by PAGE_SIZE and reports the total; a page past the end is empty", async () => {
    for (let i = 0; i < PAGE_SIZE + 1; i++) await add(`p${String(i).padStart(3, "0")}@example.test`);
    const p1 = await searchSubscribers(tdb.db, { q: "", status: "all", page: 1 });
    const p2 = await searchSubscribers(tdb.db, { q: "", status: "all", page: 2 });
    const p9 = await searchSubscribers(tdb.db, { q: "", status: "all", page: 9 });
    expect([p1.items.length, p2.items.length, p9.items.length, p1.total, p1.pageSize]).toEqual([PAGE_SIZE, 1, 0, PAGE_SIZE + 1, PAGE_SIZE]);
  });

  it("detail splits public lists, all news and named media lists, and explains a disabled status", async () => {
    const s = await add("d@example.test", { status: "disabled" });
    await tdb.db.insert(subscriptions).values([
      { subscriberId: s.id, listKey: "*" },
      { subscriberId: s.id, listKey: "ministries:health" },
      { subscriberId: s.id, listKey: "media-distribution-lists:budget" },
    ]);
    await tdb.db.insert(subscriberHistory).values({ subscriberId: s.id, actor: "distribution-bounce", action: "bounce-disabled", detail: "10/15d" });
    const d = await getSubscriberDetail(tdb.db, s.id);
    expect(d).toMatchObject({
      email: "d@example.test", status: "disabled", allNews: true, listKeys: ["ministries:health"],
      mediaLists: [{ listKey: "media-distribution-lists:budget", name: "Budget" }], disabledReason: "bounces", bouncedEmails: 0, bounceWindowDays: 15,
    });
    await tdb.db.insert(subscriberHistory).values({ subscriberId: s.id, actor: "Jamie", action: "staff-deactivated", at: new Date(Date.now() + 1000) });
    expect((await getSubscriberDetail(tdb.db, s.id))!.disabledReason).toBe("staff");
    expect(await getSubscriberDetail(tdb.db, "00000000-0000-0000-0000-000000000000")).toBeNull();
  });

  it("history is newest first; an unknown subscriber is null", async () => {
    const s = await add("h@example.test");
    await tdb.db.insert(subscriberHistory).values([
      { subscriberId: s.id, actor: "subscriber", action: "subscribed", at: new Date("2026-10-01T00:00:00Z") },
      { subscriberId: s.id, actor: "Jamie", action: "staff-deactivated", at: new Date("2026-10-02T00:00:00Z") },
    ]);
    expect((await listHistory(tdb.db, s.id))!.map((h) => h.action)).toEqual(["staff-deactivated", "subscribed"]);
    expect(await listHistory(tdb.db, "00000000-0000-0000-0000-000000000000")).toBeNull();
  });

  it("list options are enabled public categories' active lists only — never media", async () => {
    // emergency:alerts is seeded by migration 0005 (active, in the enabled "emergency" category).
    expect(await listOptions(tdb.db)).toEqual({
      categories: [
        { key: "ministries", name: "Ministries", lists: [{ listKey: "ministries:health", name: "Health" }] },
        { key: "emergency", name: "Emergency Info BC", lists: [{ listKey: "emergency:alerts", name: "Emergency Info BC Alerts" }] },
      ],
    });
  });
});

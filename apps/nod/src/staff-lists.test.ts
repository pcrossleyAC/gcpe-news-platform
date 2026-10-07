import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import type { TestDatabase } from "@gcpe/db-kit";
import type { EventEnvelope } from "@gcpe/events";
import { createNodTestDb } from "../test/helpers";
import { lists, operationsLog, subscribers, subscriptions } from "./db/schema";
import { activeListKeys, listsHandler, publicListItems } from "./lists";
import { updatePreferences } from "./staff-subscribers/actions";
import { listOptions } from "./staff-subscribers/read";
import { countSubscribers } from "./subscribers";
import { ListNotFoundError, ManagedInNrmsError, OrderOutOfDateError, reorderCategories, reorderLists, setCategoryEnabled, setListEnabled, staffListsView } from "./staff-lists";

describe("staff lists", () => {
  let tdb: TestDatabase;

  beforeAll(async () => {
    tdb = await createNodTestDb();
  });
  afterAll(async () => tdb.drop());
  beforeEach(async () => {
    await tdb.db.execute(sql`
      DELETE FROM subscribers; DELETE FROM operations_log;
      DELETE FROM lists WHERE category <> 'emergency';
      INSERT INTO list_categories (key, name, enabled, sort_order) VALUES ('ministries','Ministries',true,1),('sectors','Sectors',true,2),('media-distribution-lists','Media distribution lists',true,9)
        ON CONFLICT (key) DO UPDATE SET enabled = EXCLUDED.enabled, sort_order = EXCLUDED.sort_order;
      INSERT INTO lists (list_key, category, key, name, active, sort_order) VALUES
        ('ministries:health','ministries','health','Health',true,1),
        ('ministries:energy','ministries','energy','Energy',true,2),
        ('ministries:old','ministries','old','Old ministry',false,3),
        ('media-distribution-lists:budget','media-distribution-lists','budget','Budget',true,1)`);
  });

  const addActive = async (email: string, keys: string[]) => {
    const [s] = await tdb.db.insert(subscribers).values({ email, status: "active", verifiedAt: new Date(), asItHappens: true }).returning();
    if (keys.length) await tdb.db.insert(subscriptions).values(keys.map((listKey) => ({ subscriberId: s!.id, listKey })));
    return s!;
  };

  it("counts active subscribers per list and all news, in category then list order; media is read-only", async () => {
    await addActive("a@example.test", ["*", "ministries:health"]);
    await addActive("b@example.test", ["ministries:health"]);
    const [d] = await tdb.db.insert(subscribers).values({ email: "c@example.test", status: "disabled" }).returning();
    await tdb.db.insert(subscriptions).values({ subscriberId: d!.id, listKey: "ministries:health" });
    const view = await staffListsView(tdb.db);
    expect(view.allNews).toBe(1);
    expect(view.categories.map((c) => c.key).slice(0, 2)).toEqual(["ministries", "sectors"]);
    const ministries = view.categories.find((c) => c.key === "ministries")!;
    expect(ministries).toMatchObject({ namesFrom: "Core", editable: true, enabled: true });
    expect(ministries.lists.map((l) => [l.key, l.subscribers, l.active])).toEqual([["health", 2, true], ["energy", 0, true], ["old", 0, false]]);
    expect(view.categories.find((c) => c.key === "media-distribution-lists")).toMatchObject({ namesFrom: "NRMS", editable: false });
    expect(view.categories.find((c) => c.key === "emergency")).toMatchObject({ namesFrom: "NoD", editable: true });
  });

  it("disabling a list keeps its subscribers: hidden from every choice, kept through a staff save, still a recipient", async () => {
    const s = await addActive("keep@example.test", ["ministries:health"]);
    expect(await setListEnabled(tdb.db, "ministries:health", false, "Jamie")).toEqual({ changed: true });
    expect((await publicListItems(tdb.db, "ministries")).map((l) => l.key)).toEqual(["energy"]);
    expect(await activeListKeys(tdb.db, ["ministries:health"])).toEqual([]);
    expect((await listOptions(tdb.db)).categories.flatMap((c) => c.lists.map((l) => l.listKey))).not.toContain("ministries:health");
    await updatePreferences(tdb.db, s.id, { asItHappens: true, digest: false, allNews: false, listKeys: ["ministries:health", "ministries:energy"] }, "Jamie");
    const held = await tdb.db.select({ k: subscriptions.listKey }).from(subscriptions).where(eq(subscriptions.subscriberId, s.id));
    expect(held.map((h) => h.k).sort()).toEqual(["ministries:energy", "ministries:health"]);
    expect(await countSubscribers(tdb.db, ["ministries:health"])).toBe(1);
    expect(await setListEnabled(tdb.db, "ministries:health", false, "Jamie")).toEqual({ changed: false });
    const log = await tdb.db.select().from(operationsLog);
    expect(log.map((l) => [l.action, l.detail, l.actor])).toEqual([["list-disabled", "ministries:health", "Jamie"]]);
  });

  it("a Core upsert keeps staff choices: enabled and staff order survive a rename and re-sort", async () => {
    await setListEnabled(tdb.db, "ministries:health", false, "Jamie");
    await reorderLists(tdb.db, "ministries", ["ministries:energy", "ministries:old", "ministries:health"], "Jamie");
    const event = { source: "core", type: "org.upserted", data: { key: "health", displayName: "Health (renamed)", sortOrder: 0, isActive: true } } as unknown as EventEnvelope;
    await tdb.db.transaction(async (tx) => listsHandler(event)!(tx, event));
    const [row] = await tdb.db.select().from(lists).where(eq(lists.listKey, "ministries:health"));
    expect(row).toMatchObject({ name: "Health (renamed)", sortOrder: 0, enabled: false, staffSortOrder: 3 });
    expect((await staffListsView(tdb.db)).categories.find((c) => c.key === "ministries")!.lists.map((l) => l.key)).toEqual(["energy", "old", "health"]);
  });

  it("a list Core adds after a reorder sorts after the staff-ordered ones", async () => {
    await reorderLists(tdb.db, "ministries", ["ministries:old", "ministries:energy", "ministries:health"], "Jamie");
    await tdb.db.execute(sql`INSERT INTO lists (list_key, category, key, name, sort_order) VALUES ('ministries:aaa','ministries','aaa','Aaa',0)`);
    expect((await publicListItems(tdb.db, "ministries")).map((l) => l.key)).toEqual(["energy", "health", "aaa"]);
    expect((await staffListsView(tdb.db)).categories.find((c) => c.key === "ministries")!.lists.map((l) => l.key)).toEqual(["old", "energy", "health", "aaa"]);
  });

  it("an order must be an exact permutation", async () => {
    await expect(reorderLists(tdb.db, "ministries", ["ministries:health", "ministries:energy"], "J")).rejects.toBeInstanceOf(OrderOutOfDateError);
    await expect(reorderLists(tdb.db, "ministries", ["ministries:health", "ministries:health", "ministries:old"], "J")).rejects.toBeInstanceOf(OrderOutOfDateError);
    const all = (await staffListsView(tdb.db)).categories.map((c) => c.key);
    await expect(reorderCategories(tdb.db, all.slice(1), "J")).rejects.toBeInstanceOf(OrderOutOfDateError);
    await reorderCategories(tdb.db, [...all].reverse(), "J");
    expect((await staffListsView(tdb.db)).categories.map((c) => c.key)).toEqual([...all].reverse());
  });

  it("media lists and their category are managed in NRMS; unknown keys are not found", async () => {
    await expect(setListEnabled(tdb.db, "media-distribution-lists:budget", false, "J")).rejects.toBeInstanceOf(ManagedInNrmsError);
    await expect(setCategoryEnabled(tdb.db, "media-distribution-lists", false, "J")).rejects.toBeInstanceOf(ManagedInNrmsError);
    await expect(reorderLists(tdb.db, "media-distribution-lists", ["media-distribution-lists:budget"], "J")).rejects.toBeInstanceOf(ManagedInNrmsError);
    await expect(setListEnabled(tdb.db, "ministries:nope", false, "J")).rejects.toBeInstanceOf(ListNotFoundError);
    await expect(setCategoryEnabled(tdb.db, "nope", false, "J")).rejects.toBeInstanceOf(ListNotFoundError);
  });

  it("disabling a category hides its lists from the public and records who did it", async () => {
    expect(await setCategoryEnabled(tdb.db, "ministries", false, "Jamie")).toEqual({ changed: true });
    expect(await publicListItems(tdb.db, "ministries")).toEqual([]);
    expect((await tdb.db.select().from(operationsLog)).map((l) => [l.action, l.detail])).toEqual([["category-disabled", "ministries"]]);
  });
});

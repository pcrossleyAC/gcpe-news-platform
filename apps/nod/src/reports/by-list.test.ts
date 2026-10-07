import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { TestDatabase } from "@gcpe/db-kit";
import { createNodTestDb } from "../../test/helpers";
import { lists, subscribers, subscriptions } from "../db/schema";
import { memberBatches, membersPage, ReportListNotFoundError, subscribersByList } from "./by-list";

describe("active subscribers by list", () => {
  let tdb: TestDatabase;

  beforeAll(async () => {
    tdb = await createNodTestDb();
    await tdb.db.insert(lists).values([
      { listKey: "ministries:health", category: "ministries", key: "health", name: "Health" },
      { listKey: "ministries:finance", category: "ministries", key: "finance", name: "Finance" },
    ]);
    const [a, b, c, d] = await tdb.db
      .insert(subscribers)
      .values([
        { email: "alex@example.test", status: "active", asItHappens: true, digest: false },
        { email: "Blake@example.test", status: "active", asItHappens: false, digest: true },
        { email: "casey@example.test", status: "disabled", asItHappens: true, digest: false },
        { email: "dana@example.test", status: "active", asItHappens: true, digest: true },
      ])
      .returning({ id: subscribers.id });
    await tdb.db.insert(subscriptions).values([
      { subscriberId: a!.id, listKey: "ministries:health" },
      { subscriberId: b!.id, listKey: "ministries:health" },
      { subscriberId: b!.id, listKey: "ministries:finance" },
      { subscriberId: c!.id, listKey: "ministries:health" },
      { subscriberId: d!.id, listKey: "*" },
    ]);
  });
  afterAll(async () => tdb.drop());

  it("counts active subscribers per list, split by timing, with All news and everyone", async () => {
    const r = await subscribersByList(tdb.db);
    expect(r.all).toEqual({ subscribers: 3, asItHappens: 2, digest: 2 });
    expect(r.allNews).toEqual({ subscribers: 1, asItHappens: 1, digest: 1 });
    const ministries = r.categories.find((c) => c.key === "ministries")!;
    expect(ministries.lists.find((l) => l.listKey === "ministries:health")).toMatchObject({ name: "Health", subscribers: 2, asItHappens: 1, digest: 1 });
    expect(ministries.lists.find((l) => l.listKey === "ministries:finance")).toMatchObject({ subscribers: 1, asItHappens: 0, digest: 1 });
  });

  it("pages a list's active members by address, case-insensitively, filtered by timing", async () => {
    const health = await membersPage(tdb.db, { list: "ministries:health", timing: "any", page: 1 });
    expect(health).toMatchObject({ list: "ministries:health", listName: "Health", total: 2, page: 1, pageSize: 50 });
    expect(health.items.map((m) => m.email)).toEqual(["alex@example.test", "Blake@example.test"]);
    expect((await membersPage(tdb.db, { list: "ministries:health", timing: "digest", page: 1 })).items.map((m) => m.email)).toEqual(["Blake@example.test"]);
    expect((await membersPage(tdb.db, { list: "all", timing: "any", page: 1 })).items.map((m) => m.email)).toEqual([
      "alex@example.test",
      "Blake@example.test",
      "dana@example.test",
    ]);
    expect((await membersPage(tdb.db, { list: "*", timing: "any", page: 1 })).listName).toBe("All news");
  });

  it("refuses a list that doesn't exist", async () => {
    await expect(membersPage(tdb.db, { list: "ministries:nope", timing: "any", page: 1 })).rejects.toBeInstanceOf(ReportListNotFoundError);
  });

  it("yields members in keyset batches, in the same order as the page", async () => {
    const seen: string[][] = [];
    for await (const batch of memberBatches(tdb.db, "all", "any", 2)) seen.push(batch.map((m) => m.email));
    expect(seen).toEqual([["alex@example.test", "Blake@example.test"], ["dana@example.test"]]);
  });
});

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { TestDatabase } from "@gcpe/db-kit";
import { createPublicSiteTestDb } from "../test/helpers";
import { completePage, deferPage, dependentPriority, enqueuePages, nextBatch, PRIORITY, queueDepth } from "./queue";

describe("rebuild queue", () => {
  let tdb: TestDatabase;
  beforeAll(async () => { tdb = await createPublicSiteTestDb(); });
  afterAll(async () => { await tdb.drop(); });
  beforeEach(async () => { await tdb.pool.query("TRUNCATE rebuild_queue RESTART IDENTITY"); });
  const ids = async () => (await nextBatch(tdb.db, 100, [])).map((i) => `${i.pageId}@${i.priority}`);

  it("orders by priority, then by when it was queued", async () => {
    await enqueuePages(tdb.db, [{ pageId: "post:B", priority: PRIORITY.bulkPost }, { pageId: "home", priority: PRIORITY.liveAggregate }, { pageId: "post:A", priority: PRIORITY.bulkPost }]);
    await enqueuePages(tdb.db, [{ pageId: "post:L", priority: PRIORITY.livePost }]);
    expect(await ids()).toEqual(["post:L@0", "home@1", "post:B@2", "post:A@2"]);
  });

  it("a repeated page id in one call keeps the lowest priority (no ON CONFLICT error)", async () => {
    await enqueuePages(tdb.db, [{ pageId: "home", priority: 3 }, { pageId: "home", priority: 1 }, { pageId: "home", priority: 2 }]);
    expect(await ids()).toEqual(["home@1"]);
  });

  it("re-enqueueing keeps the lower priority and moves the page to the back of it", async () => {
    await enqueuePages(tdb.db, [{ pageId: "a", priority: 1 }, { pageId: "b", priority: 1 }]);
    await enqueuePages(tdb.db, [{ pageId: "a", priority: 3 }]);
    expect(await ids()).toEqual(["b@1", "a@1"]);
  });

  it("a page re-queued during its render stays queued", async () => {
    await enqueuePages(tdb.db, [{ pageId: "post:K", priority: 0 }]);
    const [item] = await nextBatch(tdb.db, 1, []);
    await enqueuePages(tdb.db, [{ pageId: "post:K", priority: 0 }]); // a second change lands mid-render
    expect(await completePage(tdb.db, item!)).toBe(false);
    expect(await queueDepth(tdb.db)).toBe(1);
    const [again] = await nextBatch(tdb.db, 1, []);
    expect(await completePage(tdb.db, again!)).toBe(true);
    expect(await queueDepth(tdb.db)).toBe(0);
  });

  it("deferPage moves a page to the back of its priority and counts the attempt", async () => {
    await enqueuePages(tdb.db, [{ pageId: "x", priority: 2 }, { pageId: "y", priority: 2 }]);
    const [x] = await nextBatch(tdb.db, 1, []);
    await deferPage(tdb.db, x!);
    const batch = await nextBatch(tdb.db, 10, []);
    expect(batch.map((i) => [i.pageId, i.attempts])).toEqual([["y", 0], ["x", 1]]);
  });

  it("nextBatch skips the given ids", async () => {
    await enqueuePages(tdb.db, [{ pageId: "x", priority: 2 }, { pageId: "y", priority: 2 }]);
    expect((await nextBatch(tdb.db, 10, ["x"])).map((i) => i.pageId)).toEqual(["y"]);
  });

  it("takes 100,000 pages in one call, in input order", async () => {
    const items = Array.from({ length: 100_000 }, (_, i) => ({ pageId: `post:K${100_000 - i}`, priority: 2 }));
    await enqueuePages(tdb.db, items);
    expect(await queueDepth(tdb.db)).toBe(100_000);
    expect((await nextBatch(tdb.db, 2, [])).map((i) => i.pageId)).toEqual(["post:K100000", "post:K99999"]);
  });

  it("dependents of a post go one priority later", () => {
    expect(dependentPriority(PRIORITY.livePost)).toBe(PRIORITY.liveAggregate);
    expect(dependentPriority(PRIORITY.bulkPost)).toBe(PRIORITY.bulkAggregate);
    expect(dependentPriority(PRIORITY.liveAggregate)).toBe(PRIORITY.liveAggregate);
  });
});

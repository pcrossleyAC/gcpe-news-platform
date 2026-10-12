import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { TestDatabase } from "@gcpe/db-kit";
import { createPublicSiteTestDb } from "../test/helpers";
import { fakeNewsApi } from "../test/fake-news-api";
import { memoryStorage } from "../test/memory-storage";
import { post, site } from "../test/fixtures";
import { createSiteBuilder } from "./builder";
import { drainQueue } from "./drain";
import { postIndex } from "./post-index";
import { enqueuePages, PRIORITY, queueDepth } from "./queue";

describe("drainQueue", () => {
  let tdb: TestDatabase;
  beforeAll(async () => { tdb = await createPublicSiteTestDb(); });
  afterAll(async () => { await tdb.drop(); });
  beforeEach(async () => { await tdb.pool.query("TRUNCATE site_posts"); await tdb.pool.query("TRUNCATE rebuild_queue RESTART IDENTITY"); });

  const setup = () => {
    const storage = memoryStorage();
    const api = fakeNewsApi();
    const builder = createSiteBuilder({ newsApi: api, storage, index: postIndex(tdb.db), site, assetsDir: null });
    return { storage, api, builder };
  };

  it("renders a live post, then its dependents in the same run", async () => {
    const { storage, api, builder } = setup();
    api.posts.set("K1", post({ key: "K1" }));
    await enqueuePages(tdb.db, [{ pageId: "post:K1", priority: PRIORITY.livePost }]);
    const r = await drainQueue({ db: tdb.db, builder }, { budget: 200, pageOpts: {} });
    expect(r.remaining).toBe(0);
    expect(storage.files.has("releases/K1/index.html")).toBe(true);
    expect(storage.files.has("ministries/health/index.html")).toBe(true);
    expect(storage.files.has("archive/2026/10/index.html")).toBe(true);
  });

  it("stops at the budget and leaves the rest queued", async () => {
    const { api, builder } = setup();
    for (let i = 0; i < 5; i++) api.posts.set(`K${i}`, post({ key: `K${i}` }));
    await enqueuePages(tdb.db, [...api.posts.keys()].map((k) => ({ pageId: `post:${k}`, priority: PRIORITY.bulkPost })));
    const r = await drainQueue({ db: tdb.db, builder }, { budget: 3, pageOpts: {} });
    expect(r.rendered).toBe(3);
    expect(r.remaining).toBeGreaterThan(0);
  });

  it("bulk posts' dependents wait behind every bulk post", async () => {
    const { storage, api, builder } = setup();
    for (let i = 0; i < 3; i++) api.posts.set(`K${i}`, post({ key: `K${i}` }));
    await enqueuePages(tdb.db, [...api.posts.keys()].map((k) => ({ pageId: `post:${k}`, priority: PRIORITY.bulkPost })));
    await drainQueue({ db: tdb.db, builder }, { budget: 3, pageOpts: {} });
    expect(storage.files.has("index.html")).toBe(false); // home is priority 3, behind the three posts
  });

  it("a failing page goes to the back and is tried once per run", async () => {
    const { storage, api, builder } = setup();
    api.posts.set("OK", post({ key: "OK" }));
    let calls = 0;
    const getPost = api.getPost;
    api.getPost = async (key) => { if (key === "BAD") { calls++; throw new Error("News API 500"); } return getPost(key); };
    await enqueuePages(tdb.db, [{ pageId: "post:BAD", priority: 0 }, { pageId: "post:OK", priority: 0 }]);
    const r = await drainQueue({ db: tdb.db, builder }, { budget: 200, pageOpts: {} });
    expect(calls).toBe(1);
    expect(r.deferred).toBe(1);
    expect(storage.files.has("releases/OK/index.html")).toBe(true);
    const { rows } = await tdb.pool.query("SELECT attempts FROM rebuild_queue WHERE page_id = 'post:BAD'");
    expect(rows[0].attempts).toBe(1);
  });

  it("an invalid page id is dropped from the queue without writing anything", async () => {
    const { storage, builder } = setup();
    await enqueuePages(tdb.db, [{ pageId: "post:../../etc", priority: 0 }]);
    await drainQueue({ db: tdb.db, builder }, { budget: 10, pageOpts: {} });
    expect(await queueDepth(tdb.db)).toBe(0);
    expect(storage.files.size).toBe(0);
  });
});

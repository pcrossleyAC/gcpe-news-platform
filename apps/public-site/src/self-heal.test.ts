import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { TestDatabase } from "@gcpe/db-kit";
import { createPublicSiteTestDb } from "../test/helpers";
import { fakeNewsApi } from "../test/fake-news-api";
import { memoryStorage } from "../test/memory-storage";
import { post, site } from "../test/fixtures";
import type { PostDto } from "./dto";
import { createSiteBuilder } from "./builder";
import { postIndex } from "./post-index";
import { enqueuePages, PRIORITY, queueDepth } from "./queue";
import { RENDER_CHROME_VERSION } from "./rebuild";
import { selfHeal } from "./self-heal";
import type { SyncDeps } from "./sync";

const SUBSCRIBE_FILES = ["subscribe/index.html", "subscribe/manage/index.html", "subscribe/unsubscribe/index.html"];

describe("selfHeal", () => {
  let tdb: TestDatabase;
  beforeAll(async () => { tdb = await createPublicSiteTestDb(); });
  afterAll(async () => { await tdb.drop(); });
  beforeEach(async () => { await tdb.pool.query("TRUNCATE site_posts"); await tdb.pool.query("TRUNCATE rebuild_queue RESTART IDENTITY"); });

  const setup = (posts = new Map<string, PostDto>(), batch = 200): SyncDeps => {
    const storage = memoryStorage();
    const newsApi = fakeNewsApi(posts);
    const index = postIndex(tdb.db);
    const builder = createSiteBuilder({ newsApi, storage, index, site, assetsDir: null });
    return { db: tdb.db, builder, index, newsApi, storage, site, test: false, batch };
  };

  it("an empty output folder queues a rebuild-all and drains one batch", async () => {
    const posts = new Map([["K1", post({ key: "K1" })], ["K2", post({ key: "K2", publishDate: "2026-09-01T10:00:00-07:00" })]]);
    const deps = setup(posts);
    const storage = deps.storage as ReturnType<typeof memoryStorage>;

    const result = await selfHeal(deps);
    expect(result).not.toBeNull();
    expect(result!.rebuilt).toBeGreaterThan(0);
    expect(storage.files.has("index.html")).toBe(true);
    expect(storage.files.has("releases/K1/index.html")).toBe(true);
    expect(storage.files.has("releases/K2/index.html")).toBe(true);
    for (const f of SUBSCRIBE_FILES) expect(storage.files.has(f)).toBe(true);
  });

  it("a News API outage logs, never throws, returns null, and still writes the subscribe pages", async () => {
    const deps = setup();
    const storage = deps.storage as ReturnType<typeof memoryStorage>;
    deps.newsApi.home = async () => {
      throw new Error("News API down");
    };
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const result = await selfHeal(deps);
      expect(result).toBeNull();
      expect(errSpy).toHaveBeenCalled();
      for (const f of SUBSCRIBE_FILES) expect(storage.files.has(f)).toBe(true);
      expect(storage.files.has("index.html")).toBe(false); // nothing else could be rendered correctly
    } finally {
      errSpy.mockRestore();
    }
  });

  it("the current marker and index.html present: drains whatever is queued, and returns null when nothing was rendered", async () => {
    const posts = new Map([["K1", post({ key: "K1" })]]);
    const deps = setup(posts);
    const storage = deps.storage as ReturnType<typeof memoryStorage>;
    await selfHeal(deps); // bootstrap, writes the marker and index.html

    const newsApi = deps.newsApi as ReturnType<typeof fakeNewsApi>;
    const before = storage.files.get("releases/K1/index.html");
    const getPostCallsBefore = newsApi.calls.filter((c) => c === "getPost:K1").length;

    const nothingQueued = await selfHeal(deps);
    expect(nothingQueued).toBeNull();
    expect(storage.files.get("releases/K1/index.html")).toBe(before); // untouched
    expect(newsApi.calls.filter((c) => c === "getPost:K1").length).toBe(getPostCallsBefore); // no further post render
    for (const f of SUBSCRIBE_FILES) expect(storage.files.has(f)).toBe(true);
    expect(storage.files.has("assets/theme.css")).toBe(true);
    expect(storage.files.has("robots.txt")).toBe(true);
    expect(storage.files.has("404.html")).toBe(true);

    // The chrome hasn't changed, so a page queued by something else (not a full rebuild) still
    // drains on the next self-heal.
    await enqueuePages(tdb.db, [{ pageId: "post:K1", priority: PRIORITY.livePost }]);
    const drained = await selfHeal(deps);
    expect(drained).not.toBeNull();
    expect(drained!.rebuilt).toBeGreaterThan(0); // the post, then its dependents, all drained this run
    expect(await queueDepth(tdb.db)).toBe(0);
    expect(JSON.parse(storage.files.get(".site-state.json") as string).chrome).toBe(RENDER_CHROME_VERSION);
  });
});

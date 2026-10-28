import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { TestDatabase } from "@gcpe/db-kit";
import { createPublicSiteTestDb } from "../test/helpers";
import { fakeNewsApi } from "../test/fake-news-api";
import { memoryStorage } from "../test/memory-storage";
import { bcSettings, post, site } from "../test/fixtures";
import type { PostDto } from "./dto";
import { createSiteBuilder } from "./builder";
import { postIndex } from "./post-index";
import { enqueuePages, PRIORITY, queueDepth } from "./queue";
import { RENDER_CHROME_VERSION } from "./rebuild";
import { selfHeal } from "./self-heal";
import type { SyncDeps } from "./sync";
import type { PageOptions } from "./render";
import * as subscribePages from "./subscribe-pages";

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

  it("ministries() down: subscribe pages written with ministryMenu null, marker untouched, returns null", async () => {
    const deps = setup();
    const storage = deps.storage as ReturnType<typeof memoryStorage>;
    deps.newsApi.ministries = async () => {
      throw new Error("ministries down");
    };
    const opts: PageOptions[] = [];
    const spy = vi.spyOn(subscribePages, "writeSubscribePages").mockImplementation(async (_s, _site, o) => void opts.push(o as PageOptions));
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(await selfHeal(deps)).toBeNull();
      expect(opts).toHaveLength(1);
      expect(opts[0]?.ministryMenu).toBeNull();
      expect(storage.files.has(".site-state.json")).toBe(false);
      expect(storage.files.has("index.html")).toBe(false);
      expect(errSpy).toHaveBeenCalled();
    } finally {
      spy.mockRestore();
      errSpy.mockRestore();
    }
  });

  it("writes the builtin assets even when the News API is down", async () => {
    const deps = setup();
    const storage = deps.storage as ReturnType<typeof memoryStorage>;
    deps.newsApi.home = async () => {
      throw new Error("News API down");
    };
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await selfHeal(deps);
      expect(storage.files.has("favicon.ico")).toBe(true);
      expect(storage.files.has("assets/legacy/Content/site.css")).toBe(true);
      expect(storage.files.has("assets/legacy/fonts/BCSans-Regular.woff2")).toBe(true);
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

  it("renders with the published site settings, the subscribe pages included", async () => {
    const deps = setup(new Map([["K1", post({ key: "K1" })]]));
    const storage = deps.storage as ReturnType<typeof memoryStorage>;
    const document = bcSettings();
    document.footer.copyrightHolder = "Published Holder";
    (deps.newsApi as ReturnType<typeof fakeNewsApi>).settings = { revision: 1, document };
    await selfHeal(deps);
    expect(storage.files.get("index.html")).toContain("Published Holder");
    for (const f of SUBSCRIBE_FILES) expect(storage.files.get(f)).toContain("Published Holder");
  });

  it("a settings section changed since the marker queues only its pages", async () => {
    const deps = setup(new Map([["K1", post({ key: "K1" })]]));
    const newsApi = deps.newsApi as ReturnType<typeof fakeNewsApi>;
    newsApi.settings = { revision: 1, document: bcSettings() };
    await selfHeal(deps);
    const document = bcSettings();
    document.connect.blogs.accounts = [{ text: "A New Blog", url: "https://blog.example" }];
    newsApi.settings = { revision: 2, document };
    const before = newsApi.calls.filter((c) => c === "getPost:K1").length;
    await selfHeal(deps);
    expect(newsApi.calls.filter((c) => c === "getPost:K1").length).toBe(before); // no full rebuild
    expect((deps.storage as ReturnType<typeof memoryStorage>).files.get("connect/index.html")).toContain("A New Blog");
  });

  it("a News API outage after a restart: the subscribe pages keep the persisted published footer, and nothing moves the marker", async () => {
    const deps = setup(new Map([["K1", post({ key: "K1" })]]));
    const storage = deps.storage as ReturnType<typeof memoryStorage>;
    const document = bcSettings();
    document.footer.copyrightHolder = "Published Holder";
    (deps.newsApi as ReturnType<typeof fakeNewsApi>).settings = { revision: 1, document };
    await selfHeal(deps);
    const marker = storage.files.get(".site-state.json");

    // A new process over the same folder (a fresh storage object, the same files).
    const restarted = { ...deps, storage: { ...storage } as typeof storage, newsApi: fakeNewsApi() };
    restarted.newsApi.home = async () => {
      throw new Error("News API down");
    };
    restarted.newsApi.siteSettings = async () => {
      throw new Error("News API down");
    };
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(await selfHeal(restarted)).toBeNull();
    } finally {
      errSpy.mockRestore();
    }
    for (const f of SUBSCRIBE_FILES) {
      expect(storage.files.get(f)).toContain("Published Holder");
      expect(storage.files.get(f)).not.toMatch(/© \d{4} Government of British Columbia/);
    }
    expect(storage.files.get(".site-state.json")).toBe(marker);
  });

  it("a settings fetch failure after a restart doesn't delay Blue Bridge: rebuild-all with the persisted document, settings hashes unchanged", async () => {
    const deps = setup(new Map([["K1", post({ key: "K1" })]]));
    const storage = deps.storage as ReturnType<typeof memoryStorage>;
    const document = bcSettings();
    document.footer.copyrightHolder = "Published Holder";
    (deps.newsApi as ReturnType<typeof fakeNewsApi>).settings = { revision: 1, document };
    await selfHeal(deps);
    const before = JSON.parse(storage.files.get(".site-state.json") as string);
    expect(before.granvilleOn).toBe(false);

    const restarted = { ...deps, storage: { ...storage } as typeof storage, newsApi: fakeNewsApi(new Map([["K1", post({ key: "K1" })]])) };
    restarted.newsApi.home = async () => ({ granville: "true", topPostKey: null, featurePostKey: null });
    restarted.newsApi.siteSettings = async () => {
      throw new Error("News API 503 for api/v2/site-settings");
    };
    restarted.builder = createSiteBuilder({ newsApi: restarted.newsApi, storage: restarted.storage, index: deps.index, site, assetsDir: null });
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(await selfHeal(restarted)).not.toBeNull();
    } finally {
      errSpy.mockRestore();
    }
    const after = JSON.parse(storage.files.get(".site-state.json") as string);
    expect(after.granvilleOn).toBe(true);
    for (const k of ["footerHash", "themeHash", "bannerHash", "connectHash", "ministryPagesHash"]) expect(after[k]).toBe(before[k]);
    expect(storage.files.get("releases/K1/index.html")).toContain('class="blue-bridge-banner"');
    expect(storage.files.get("releases/K1/index.html")).toContain("Published Holder");
  });
});

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { TestDatabase } from "@gcpe/db-kit";
import { createPublicSiteTestDb } from "../test/helpers";
import { fakeNewsApi } from "../test/fake-news-api";
import { memoryStorage } from "../test/memory-storage";
import { bcSettings, post, site } from "../test/fixtures";
import type { FakeNewsApi } from "../test/fake-news-api";
import type { SiteSettings } from "@gcpe/site-settings";
import type { PostDto } from "./dto";
import { createSiteBuilder, type SiteBuilder } from "./builder";
import { postIndex } from "./post-index";
import { queueDepth } from "./queue";
import { RENDER_CHROME_VERSION } from "./rebuild";
import { syncSite, type SyncDeps } from "./sync";

describe("syncSite", () => {
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

  it("an event's pages are queued live and rendered in the same turn", async () => {
    const posts = new Map([["K1", post({ key: "K1" })]]);
    const deps = setup(posts);
    const storage = deps.storage as ReturnType<typeof memoryStorage>;
    await syncSite(deps, { pages: ["home", "post:K1"] });
    expect(storage.files.has("index.html")).toBe(true);
    expect(storage.files.has("releases/K1/index.html")).toBe(true);
    expect(await queueDepth(tdb.db)).toBe(0);
  });

  it("a chrome change queues a full rebuild, writes the marker, and renders home on the same run", async () => {
    const posts = new Map([["K1", post({ key: "K1" })]]);
    const deps = setup(posts, 5);
    const storage = deps.storage as ReturnType<typeof memoryStorage>;
    await storage.write(".site-state.json", JSON.stringify({ granvilleOn: false, test: false, chrome: 2, baseUrl: site.baseUrl }));
    await syncSite(deps);
    expect(storage.files.has("index.html")).toBe(true);
    expect(JSON.parse(storage.files.get(".site-state.json") as string).chrome).toBe(RENDER_CHROME_VERSION);
    expect(await queueDepth(tdb.db)).toBeGreaterThan(0);
  });

  it("a home() failure rejects and queues nothing", async () => {
    const deps = setup();
    deps.newsApi.home = async () => {
      throw new Error("News API down");
    };
    await expect(syncSite(deps, { pages: ["post:K1"] })).rejects.toThrow("News API down");
    expect(await queueDepth(tdb.db)).toBe(0);
    expect((deps.storage as ReturnType<typeof memoryStorage>).files.size).toBe(0);
  });

  it("turning Blue Bridge on puts the banner on home now and on every release page as the queue drains", async () => {
    const posts = new Map([
      ["K1", post({ key: "K1" })],
      ["K2", post({ key: "K2" })],
      ["K3", post({ key: "K3" })],
    ]);
    const deps = setup(posts, 200);
    const storage = deps.storage as ReturnType<typeof memoryStorage>;

    await syncSite(deps); // no marker yet: a full build, Blue Bridge off
    expect(storage.files.get("index.html")).not.toContain('class="blue-bridge-banner"');

    deps.newsApi.home = async () => ({ granville: "true", topPostKey: null, featurePostKey: null });
    await syncSite(deps);

    const releasePages = [...storage.files.entries()].filter(([path]) => /^releases\/.+\/index\.html$/.test(path));
    expect(releasePages.length).toBeGreaterThan(0);
    for (const [, content] of releasePages) expect(content as string).toContain('class="blue-bridge-banner"');
    expect(storage.files.get("index.html")).toContain('class="blue-bridge-banner"');
  });

  it("calls deps.feed, if given, before draining (events become a doorbell)", async () => {
    const deps = setup();
    const feed = vi.fn(async () => ({ changes: 0, resynced: false }));
    await syncSite({ ...deps, feed });
    expect(feed).toHaveBeenCalledOnce();
  });

  it("a feed error is logged; the turn still drains what is queued, not rejected", async () => {
    const posts = new Map([["K1", post({ key: "K1" })]]);
    const deps = setup(posts);
    const feed = vi.fn(async () => {
      throw new Error("News API changes 503");
    });
    const result = await syncSite({ ...deps, feed }, { pages: ["post:K1"] });
    expect(result.rendered).toBeGreaterThan(0);
    expect((deps.storage as ReturnType<typeof memoryStorage>).files.has("releases/K1/index.html")).toBe(true);
  });

  // A storm of events (each its own syncSite call) must not turn into a
  // storm of feed reads — concurrent callers share one in-flight call, plus at most one
  // follow-up for whoever arrived while it was running.
  it("single-flights deps.feed: 10 concurrent events cause at most 2 feed calls", async () => {
    const deps = setup();
    let calls = 0;
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const feed = vi.fn(async () => {
      calls++;
      if (calls === 1) await firstGate;
      return { changes: 0, resynced: false };
    });
    const runs = Array.from({ length: 10 }, () => syncSite({ ...deps, feed }));
    releaseFirst();
    await Promise.all(runs);
    expect(calls).toBeLessThanOrEqual(2);
    expect(feed).toHaveBeenCalledTimes(calls);
  });

  // Two `syncSite` turns can genuinely overlap now (I1): the tick and a `kickBackgroundSync` run
  // kicked after an event's transaction commits share one `SyncDeps`/`SiteStorage`, so
  // `enqueueSiteWrite`'s own serialisation (rebuild.ts) is what keeps them from interleaving.
  it("two overlapping turns with different granville — the later-enqueued one (OFF) wins the final pages and marker, and never interleaves with the first (ON)", async () => {
    const posts = new Map([["K1", post({ key: "K1" })]]);
    const deps = setup(posts);
    const order: string[] = [];
    let releaseFirstHome: ((v: { granville: string | null; topPostKey: string | null; featurePostKey: string | null }) => void) | undefined;
    const firstHomeGate = new Promise<{ granville: string | null; topPostKey: string | null; featurePostKey: string | null }>((resolve) => (releaseFirstHome = resolve));

    // chromeChanged's full-rebuild path re-fetches home() again while draining the "home"
    // page itself, so only the *first* call (turn 1's) is gated/logged here — what matters is
    // that every one of turn 2's home() calls happens only after turn 1's gated call has
    // resolved.
    let gated = false;
    deps.newsApi.home = async () => {
      if (!gated) {
        gated = true;
        order.push("start-home-1(ON, gated)");
        const result = await firstHomeGate;
        order.push("end-home-1(ON)");
        return result;
      }
      return { granville: null, topPostKey: null, featurePostKey: null };
    };

    const p1 = syncSite(deps, { pages: ["post:K1"] });
    const p2 = syncSite(deps, { pages: ["post:K1"] });

    releaseFirstHome!({ granville: "true", topPostKey: null, featurePostKey: null });
    await Promise.all([p1, p2]);

    const storage = deps.storage as ReturnType<typeof memoryStorage>;
    expect(order).toEqual(["start-home-1(ON, gated)", "end-home-1(ON)"]);
    expect(storage.files.get("releases/K1/index.html")).not.toContain('class="blue-bridge-banner"');
    expect(storage.files.get("index.html")).not.toContain('class="blue-bridge-banner"');
    expect(JSON.parse(storage.files.get(".site-state.json") as string)).toMatchObject({ granvilleOn: false, test: false, chrome: RENDER_CHROME_VERSION, baseUrl: site.baseUrl });
  });

  it("a rejected turn doesn't wedge the queue — a concurrently-enqueued later turn still runs", async () => {
    const posts = new Map([["K1", post({ key: "K1" })]]);
    const deps = setup(posts);
    let call = 0;
    deps.newsApi.home = async () => {
      call++;
      if (call === 1) throw new Error("News API down");
      return { granville: null, topPostKey: null, featurePostKey: null };
    };

    const p1 = syncSite(deps, { pages: ["post:K1"] });
    const p2 = syncSite(deps, { pages: ["post:K1"] });
    const [r1, r2] = await Promise.allSettled([p1, p2]);

    expect(r1.status).toBe("rejected");
    expect(r1.status === "rejected" && r1.reason).toMatchObject({ message: "News API down" });
    expect(r2.status).toBe("fulfilled");
    expect((deps.storage as ReturnType<typeof memoryStorage>).files.has("index.html")).toBe(true); // the second turn still ran and wrote its pages
  });

  it("a rejected turn's queue slot still settles sequentially: a later call made after awaiting it runs normally", async () => {
    const posts = new Map([["K1", post({ key: "K1" })]]);
    const deps = setup(posts);
    deps.newsApi.home = async () => {
      throw new Error("News API down");
    };
    await expect(syncSite(deps, { pages: ["post:K1"] })).rejects.toThrow("News API down");

    deps.newsApi.home = async () => ({ granville: null, topPostKey: null, featurePostKey: null });
    await expect(syncSite(deps, { pages: ["post:K1"] })).resolves.toBeDefined();
    expect((deps.storage as ReturnType<typeof memoryStorage>).files.has("index.html")).toBe(true);
  });

  describe("site settings", () => {
    const published = (doc: SiteSettings, revision = 1) => ({ revision, document: doc });
    const withHolder = (holder: string): SiteSettings => {
      const doc = bcSettings();
      doc.footer.copyrightHolder = holder;
      return doc;
    };
    /** syncSite with a builder that records which pages this turn rendered. */
    const recording = (deps: SyncDeps) => {
      const rendered: string[] = [];
      const builder: SiteBuilder = { ...deps.builder, renderPage: (id, opts, run, tx) => (rendered.push(id), deps.builder.renderPage(id, opts, run, tx)) };
      return { deps: { ...deps, builder }, rendered };
    };
    const api = (deps: SyncDeps) => deps.newsApi as FakeNewsApi;
    const html = (deps: SyncDeps, path: string) => (deps.storage as ReturnType<typeof memoryStorage>).files.get(path) as string;

    it("each turn fetches the settings; a 404 renders the tenant defaults", async () => {
      const deps = { ...setup(new Map([["K1", post({ key: "K1" })]])), defaultSettings: withHolder("Tenant Default Holder") };
      await syncSite(deps);
      await syncSite(deps);
      expect(api(deps).calls.filter((c) => c === "siteSettings")).toHaveLength(2);
      expect(html(deps, "index.html")).toContain("Tenant Default Holder");
      expect(html(deps, "releases/K1/index.html")).toContain("Tenant Default Holder");
    });

    it("the published document is applied to every page", async () => {
      const deps = { ...setup(new Map([["K1", post({ key: "K1" })]])), defaultSettings: withHolder("Tenant Default Holder") };
      api(deps).settings = published(withHolder("Published Holder"));
      await syncSite(deps);
      expect(html(deps, "index.html")).toContain("Published Holder");
      expect(html(deps, "releases/K1/index.html")).toContain("Published Holder");
    });

    it("a fetch error keeps the last applied settings (logged), never the defaults, and queues no rebuild", async () => {
      const deps = { ...setup(new Map([["K1", post({ key: "K1" })]])), defaultSettings: withHolder("Tenant Default Holder") };
      api(deps).settings = published(withHolder("Published Holder"));
      await syncSite(deps);
      const error = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        deps.newsApi.siteSettings = async () => {
          throw new Error("News API 503 for api/v2/site-settings");
        };
        const r = recording(deps);
        await syncSite(r.deps, { pages: ["post:K1"] });
        expect(r.rendered[0]).toBe("post:K1");
        expect(r.rendered).not.toContain("static"); // no rebuild queued
        expect(html(deps, "releases/K1/index.html")).toContain("Published Holder");
        expect(html(deps, "releases/K1/index.html")).not.toContain("Tenant Default Holder");
        expect(error.mock.calls.map((c) => String(c[0]))).toContainEqual(expect.stringContaining("keeping the last applied"));
      } finally {
        error.mockRestore();
      }
    });

    it("a fetch error before any successful fetch uses the tenant defaults (logged) rather than failing the turn", async () => {
      const deps = { ...setup(new Map([["K1", post({ key: "K1" })]])), defaultSettings: withHolder("Tenant Default Holder") };
      deps.newsApi.siteSettings = async () => {
        throw new Error("News API 503 for api/v2/site-settings");
      };
      const error = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        await expect(syncSite(deps)).resolves.toBeDefined();
        expect(html(deps, "index.html")).toContain("Tenant Default Holder");
        expect(error.mock.calls.map((c) => String(c[0]))).toContainEqual(expect.stringContaining("tenant defaults"));
      } finally {
        error.mockRestore();
      }
    });

    it("a footer change queues every page", async () => {
      const deps = setup(new Map([["K1", post({ key: "K1" })], ["K2", post({ key: "K2" })]]));
      await syncSite(deps);
      api(deps).settings = published(withHolder("New Holder"));
      const r = recording(deps);
      await syncSite(r.deps);
      expect(r.rendered).toEqual(expect.arrayContaining(["static", "home", "connect", "post:K1", "post:K2", "category:ministries:health"]));
      expect(html(deps, "releases/K2/index.html")).toContain("New Holder");
    });

    it("the copyright year rolling over (tenant time zone) queues every page", async () => {
      const deps = setup(new Map([["K1", post({ key: "K1" })]]));
      vi.useFakeTimers({ now: new Date("2027-01-01T06:30:00Z"), toFake: ["Date"] }); // 2026-12-31 23:30 in Vancouver (UTC-7 year-round from 2026-11-01)
      try {
        await syncSite(deps);
        expect(html(deps, "releases/K1/index.html")).toContain("© 2026");
        vi.setSystemTime(new Date("2027-01-01T07:30:00Z")); // 2027-01-01 00:30 in Vancouver
        const r = recording(deps);
        await syncSite(r.deps);
        expect(r.rendered).toContain("post:K1");
        expect(html(deps, "releases/K1/index.html")).toContain("© 2027");
      } finally {
        vi.useRealTimers();
      }
    });

    it("a theme-only change rebuilds only the static page (theme.css)", async () => {
      const deps = setup(new Map([["K1", post({ key: "K1" })]]));
      api(deps).settings = published(bcSettings());
      await syncSite(deps);
      const doc = bcSettings();
      doc.theme.colors.primary = "#123456";
      api(deps).settings = published(doc, 2);
      const r = recording(deps);
      await syncSite(r.deps);
      expect(r.rendered).toEqual(["static"]);
      expect(html(deps, "assets/theme.css")).toContain("--color-primary: #123456;");
    });

    it("a banner-only change rewrites only the static page (site-banner.json)", async () => {
      const deps = setup(new Map([["K1", post({ key: "K1" })]]));
      api(deps).settings = published(bcSettings());
      await syncSite(deps);
      const doc = bcSettings();
      doc.banner = { ...doc.banner, enabled: true, message: "Offices closed" };
      api(deps).settings = published(doc, 2);
      const r = recording(deps);
      await syncSite(r.deps);
      expect(r.rendered).toEqual(["static"]);
      expect(JSON.parse(html(deps, "assets/site-banner.json"))).toMatchObject({ visible: true, message: "Offices closed" });
    });

    it("a connect-only change rebuilds only the Connect page", async () => {
      const deps = setup(new Map([["K1", post({ key: "K1" })]]));
      api(deps).settings = published(bcSettings());
      await syncSite(deps);
      const doc = bcSettings();
      doc.connect.threads.accounts = [{ text: "@NewThreads", url: "https://threads.net/@new" }];
      api(deps).settings = published(doc, 2);
      const r = recording(deps);
      await syncSite(r.deps);
      expect(r.rendered).toEqual(["connect"]);
      expect(html(deps, "connect/index.html")).toContain("@NewThreads");
    });

    it("a ministryPages-only change rebuilds only the ministry pages", async () => {
      const deps = setup(new Map([["K1", post({ key: "K1" })]]));
      api(deps).settings = published(bcSettings());
      await syncSite(deps);
      const doc = bcSettings();
      doc.ministryPages.featuredTopics = "Topics";
      api(deps).settings = published(doc, 2);
      const r = recording(deps);
      await syncSite(r.deps);
      expect(r.rendered.sort()).toEqual(["category:ministries:finance", "category:ministries:health"]);
    });

    it("unchanged settings queue nothing", async () => {
      const deps = setup(new Map([["K1", post({ key: "K1" })]]));
      api(deps).settings = published(bcSettings());
      await syncSite(deps);
      api(deps).settings = published(bcSettings(), 2);
      const r = recording(deps);
      await syncSite(r.deps);
      expect(r.rendered).toEqual([]);
    });
  });
});

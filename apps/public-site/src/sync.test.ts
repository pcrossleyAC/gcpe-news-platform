import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { TestDatabase } from "@gcpe/db-kit";
import { createPublicSiteTestDb } from "../test/helpers";
import { fakeNewsApi } from "../test/fake-news-api";
import { memoryStorage } from "../test/memory-storage";
import { bcSettings, ministry, post, site } from "../test/fixtures";
import type { FakeNewsApi } from "../test/fake-news-api";
import type { SiteSettings } from "@gcpe/site-settings";
import type { PostDto } from "./dto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSiteBuilder, type SiteBuilder } from "./builder";
import { fsStorage } from "./storage";
import { DEFAULT_TIME_ZONE, settingsHashes } from "./settings";
import { postIndex } from "./post-index";
import * as queue from "./queue";
import { PRIORITY, queueDepth } from "./queue";
import { RENDER_CHROME_VERSION } from "./rebuild";
import { degradedSubscribe, syncSite, type SyncDeps } from "./sync";
import * as subscribePages from "./subscribe-pages";
import * as rebuildAll from "./rebuild-all";

const KIND_IDS = ["kind:releases", "kind:stories", "kind:factsheets", "kind:updates"];
const INDEX_IDS = ["ministries", "index:sectors", "index:themes", "index:tags"];

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
    expect(storage.files.get("index.html")).not.toContain('id="bridge-banner"');

    deps.newsApi.home = async () => ({ granville: "true", topPostKey: null, featurePostKey: null });
    await syncSite(deps);

    const releasePages = [...storage.files.entries()].filter(([path]) => /^releases\/.+\/index\.html$/.test(path));
    expect(releasePages.length).toBeGreaterThan(0);
    for (const [, content] of releasePages) expect(content as string).toContain('id="bridge-banner"');
    expect(storage.files.get("index.html")).toContain('id="bridge-banner"');
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
    expect(storage.files.get("releases/K1/index.html")).not.toContain('id="bridge-banner"');
    expect(storage.files.get("index.html")).not.toContain('id="bridge-banner"');
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

  describe("ministries menu", () => {
    const posts = () => new Map([["K1", post({ key: "K1" })], ["K2", post({ key: "K2" })], ["K3", post({ key: "K3" })]]);
    const marker = (deps: SyncDeps) => JSON.parse((deps.storage as ReturnType<typeof memoryStorage>).files.get(".site-state.json") as string);
    const renameHealth = (deps: SyncDeps) => {
      deps.newsApi.ministries = async () => [ministry({ key: "health", name: "Health and Wellness" }), ministry({ key: "finance", name: "Finance" })];
    };

    const queued = async () => new Set((await tdb.pool.query("SELECT page_id FROM rebuild_queue")).rows.map((r: { page_id: string }) => r.page_id));
    /** A rebuild-all (with batch 1, the first page is drained) holds every post and aggregate page; a partial rebuild does not. */
    const expectRebuildAll = async () => {
      const q = await queued();
      for (const id of ["post:K1", "post:K2", "post:K3", "archive", "sitemap"]) expect(q.has(id)).toBe(true);
    };
    const reset = () => tdb.pool.query("TRUNCATE rebuild_queue RESTART IDENTITY");

    it("a ministry renamed since the marker queues one rebuild-all; the next identical turn queues nothing", async () => {
      const deps = setup(posts(), 1);
      await syncSite(deps); // cold start: marker written
      await reset();
      renameHealth(deps);
      await syncSite(deps);
      await expectRebuildAll();
      await reset();
      await syncSite(deps);
      expect(await queueDepth(tdb.db)).toBe(0);
    });

    it("after a non-empty menu was recorded, an empty ministries() answer is unavailable: the turn rejects, and recovery queues exactly one rebuild-all", async () => {
      const deps = setup(posts(), 1);
      await syncSite(deps);
      const before = (deps.storage as ReturnType<typeof memoryStorage>).files.get(".site-state.json");
      await reset();
      deps.newsApi.ministries = async () => [];
      await expect(syncSite(deps)).rejects.toThrow(/no ministries/);
      expect(await queueDepth(tdb.db)).toBe(0);
      expect((deps.storage as ReturnType<typeof memoryStorage>).files.get(".site-state.json")).toBe(before);
      renameHealth(deps); // back, with a renamed ministry
      await syncSite(deps);
      await expectRebuildAll();
      await reset();
      await syncSite(deps);
      expect(await queueDepth(tdb.db)).toBe(0);
    });

    it("with no non-empty menu ever recorded, an empty ministries() list is a valid empty menu", async () => {
      const deps = setup(posts());
      deps.newsApi.ministries = async () => [];
      await syncSite(deps);
      const m = marker(deps);
      expect(m.ministryMenuHash).toMatch(/^[0-9a-f]{64}$/);
      await reset();
      await syncSite(deps);
      expect(await queueDepth(tdb.db)).toBe(0);
      expect((deps.storage as ReturnType<typeof memoryStorage>).files.has("index.html")).toBe(true);
    });

    it("an outage then recovery with the same menu queues nothing", async () => {
      const deps = setup(posts(), 1);
      await syncSite(deps);
      await reset();
      const good = deps.newsApi.ministries;
      deps.newsApi.ministries = async () => [];
      await expect(syncSite(deps)).rejects.toThrow();
      deps.newsApi.ministries = good;
      await syncSite(deps);
      expect(await queueDepth(tdb.db)).toBe(0);
    });

    it("a menu change on a fallback-defaults turn rebuilds every page", async () => {
      const deps = setup(posts(), 1);
      await syncSite(deps);
      await reset();
      renameHealth(deps);
      deps.newsApi.siteSettings = async () => {
        throw new Error("settings down");
      };
      const error = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        await syncSite(deps);
      } finally {
        error.mockRestore();
      }
      await expectRebuildAll();
    });

    it("subscribe pages selfHeal wrote without the menu are rewritten by the first good turn", async () => {
      const deps = setup(posts());
      await syncSite(deps);
      const rewritten: unknown[] = [];
      degradedSubscribe.add(deps.storage);
      const spy = vi.spyOn(subscribePages, "writeSubscribePages").mockImplementation(async (_s, _site, o) => void rewritten.push(o.ministryMenu));
      try {
        await syncSite(deps);
        await syncSite(deps);
      } finally {
        spy.mockRestore();
      }
      expect(rewritten).toHaveLength(1);
      expect(rewritten[0]).toEqual(expect.arrayContaining([{ key: "health", name: "Health" }]));
    });

    it("a failed rewrite of the degraded subscribe pages keeps them marked, so the next good turn retries", async () => {
      const deps = setup(posts());
      await syncSite(deps);
      degradedSubscribe.add(deps.storage);
      let calls = 0;
      const spy = vi.spyOn(subscribePages, "writeSubscribePages").mockImplementation(async () => {
        if (++calls === 1) throw new Error("disk full");
      });
      try {
        await expect(syncSite(deps)).rejects.toThrow("disk full");
        expect(degradedSubscribe.has(deps.storage)).toBe(true);
        await syncSite(deps);
        expect(calls).toBe(2);
        expect(degradedSubscribe.has(deps.storage)).toBe(false);
      } finally {
        spy.mockRestore();
      }
    });

    it("a ministries() failure rejects the turn and leaves the marker untouched", async () => {
      const deps = setup(posts());
      await syncSite(deps);
      const before = (deps.storage as ReturnType<typeof memoryStorage>).files.get(".site-state.json");
      deps.newsApi.ministries = async () => {
        throw new Error("ministries down");
      };
      await expect(syncSite(deps, { pages: ["post:K1"] })).rejects.toThrow("ministries down");
      expect((deps.storage as ReturnType<typeof memoryStorage>).files.get(".site-state.json")).toBe(before);
    });

    it("a marker written before ministryMenuHash existed does not queue a rebuild-all by itself", async () => {
      const deps = setup(posts(), 1);
      await syncSite(deps);
      const old = marker(deps);
      delete old.ministryMenuHash;
      await (deps.storage as ReturnType<typeof memoryStorage>).write(".site-state.json", JSON.stringify(old));
      await tdb.pool.query("TRUNCATE rebuild_queue RESTART IDENTITY");
      await syncSite(deps);
      expect(await queueDepth(tdb.db)).toBe(0);
      expect(marker(deps).ministryMenuHash).toMatch(/^[0-9a-f]{64}$/); // adopted, so a later change is seen
      renameHealth(deps);
      await syncSite(deps);
      expect(await queueDepth(tdb.db)).toBeGreaterThan(0);
    });
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

    it("across a restart: a fetch error keeps the persisted published settings — no rebuild queued, marker and site-banner.json unchanged, the published footer rendered", async () => {
      const dir = await mkdtemp(join(tmpdir(), "public-site-settings-restart-"));
      const posts = new Map([["K1", post({ key: "K1" })]]);
      const first = { ...setup(posts), storage: fsStorage(dir), defaultSettings: withHolder("Tenant Default Holder") };
      first.builder = createSiteBuilder({ newsApi: first.newsApi, storage: first.storage, index: first.index, site, assetsDir: null });
      const document = withHolder("Published Holder");
      document.banner = { ...document.banner, enabled: true, message: "Offices closed" };
      api(first).settings = published(document);
      await syncSite(first); // the full build under the published revision
      const marker = await readFile(join(dir, ".site-state.json"), "utf8");
      const bannerFile = await readFile(join(dir, "assets/site-banner.json"), "utf8");
      expect(JSON.parse(bannerFile)).toMatchObject({ visible: true, message: "Offices closed" });
      await tdb.pool.query("TRUNCATE rebuild_queue RESTART IDENTITY");

      // A new process: a fresh storage instance over the same folder (so nothing in memory), and
      // a News API whose home() works but whose settings fetch fails.
      const storage = fsStorage(dir);
      const newsApi = fakeNewsApi(posts);
      newsApi.siteSettings = async () => {
        throw new Error("News API 503 for api/v2/site-settings");
      };
      const builder = createSiteBuilder({ newsApi, storage, index: first.index, site, assetsDir: null });
      const restarted = recording({ ...first, storage, newsApi, builder });
      const error = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        await syncSite(restarted.deps, { pages: ["post:K1"] });
      } finally {
        error.mockRestore();
      }
      expect(restarted.rendered[0]).toBe("post:K1");
      expect(restarted.rendered).not.toContain("static"); // no rebuild-all, no section rebuild
      expect(await queueDepth(tdb.db)).toBe(0);
      expect(await readFile(join(dir, ".site-state.json"), "utf8")).toBe(marker);
      expect(await readFile(join(dir, "assets/site-banner.json"), "utf8")).toBe(bannerFile);
      const page = await readFile(join(dir, "releases/K1/index.html"), "utf8");
      expect(page).toContain("Published Holder");
      expect(page).not.toContain("Tenant Default Holder");
    });

    /** A first process builds the site under a published revision (Blue Bridge off) in a real
     * folder; then a "restarted" process over the same folder whose home() reports Blue Bridge
     * ON and whose settings fetch fails. */
    const restartWithBlueBridge = async (opts: { deletePersisted: boolean }) => {
      const dir = await mkdtemp(join(tmpdir(), "public-site-settings-bb-"));
      const posts = new Map([["K1", post({ key: "K1" })]]);
      const first = { ...setup(posts), storage: fsStorage(dir), defaultSettings: withHolder("Tenant Default Holder") };
      first.builder = createSiteBuilder({ newsApi: first.newsApi, storage: first.storage, index: first.index, site, assetsDir: null });
      api(first).settings = published(withHolder("Published Holder"));
      await syncSite(first);
      const before = JSON.parse(await readFile(join(dir, ".site-state.json"), "utf8"));
      expect(before.granvilleOn).toBe(false);
      if (opts.deletePersisted) await rm(join(dir, ".site-settings.json"));
      await tdb.pool.query("TRUNCATE rebuild_queue RESTART IDENTITY");

      const storage = fsStorage(dir);
      const newsApi = fakeNewsApi(posts);
      newsApi.home = async () => ({ granville: "true", topPostKey: null, featurePostKey: null });
      newsApi.siteSettings = async () => {
        throw new Error("News API 503 for api/v2/site-settings");
      };
      const builder = createSiteBuilder({ newsApi, storage, index: first.index, site, assetsDir: null });
      const restarted = recording({ ...first, storage, newsApi, builder });
      const error = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        await syncSite(restarted.deps);
      } finally {
        error.mockRestore();
      }
      const after = JSON.parse(await readFile(join(dir, ".site-state.json"), "utf8"));
      const settingsHashes = (m: Record<string, unknown>) => ({ footerHash: m.footerHash, identityHash: m.identityHash, headerHash: m.headerHash, labelsHash: m.labelsHash, themeHash: m.themeHash, bannerHash: m.bannerHash, connectHash: m.connectHash, ministryPagesHash: m.ministryPagesHash, releaseShareHash: m.releaseShareHash, contactsPageHash: m.contactsPageHash, privacyHash: m.privacyHash, liveTextHash: m.liveTextHash, notFoundHash: m.notFoundHash, assetLicenceHash: m.assetLicenceHash, searchTextHash: m.searchTextHash, subscribeHash: m.subscribeHash });
      return { dir, before, after, settingsHashes, rendered: restarted.rendered, page: await readFile(join(dir, "releases/K1/index.html"), "utf8") };
    };

    it("a settings fetch failure doesn't delay Blue Bridge: with a persisted document, rebuild-all is queued and the marker records it, settings hashes unchanged", async () => {
      const r = await restartWithBlueBridge({ deletePersisted: false });
      expect(r.rendered).toEqual(expect.arrayContaining(["static", "home", "post:K1"]));
      expect(r.after.granvilleOn).toBe(true);
      expect(r.settingsHashes(r.after)).toEqual(r.settingsHashes(r.before));
      expect(r.page).toContain('id="bridge-banner"');
      expect(r.page).toContain("Published Holder");
    });

    it("with nothing persisted (but a marker), Blue Bridge still rebuilds every page — with the defaults, so the marker records the defaults' hashes", async () => {
      const r = await restartWithBlueBridge({ deletePersisted: true });
      expect(r.rendered).toEqual(expect.arrayContaining(["static", "home", "post:K1"]));
      expect(r.after.granvilleOn).toBe(true);
      const defaults = settingsHashes(withHolder("Tenant Default Holder"), "America/Vancouver", new Date());
      expect(r.settingsHashes(r.after)).toEqual(defaults);
      expect(r.settingsHashes(r.after)).not.toEqual(r.settingsHashes(r.before));
      expect(r.page).toContain('id="bridge-banner"');
      expect(r.page).toContain("Tenant Default Holder"); // nothing else exists to render with
    });

    it("after that, the first successful fetch rebuilds back to the published settings and records their hashes", async () => {
      const r = await restartWithBlueBridge({ deletePersisted: true });
      await tdb.pool.query("TRUNCATE rebuild_queue RESTART IDENTITY");
      const posts = new Map([["K1", post({ key: "K1" })]]);
      const storage = fsStorage(r.dir);
      const newsApi = fakeNewsApi(posts);
      newsApi.home = async () => ({ granville: "true", topPostKey: null, featurePostKey: null });
      const document = withHolder("Published Holder");
      newsApi.settings = published(document);
      const builder = createSiteBuilder({ newsApi, storage, index: postIndex(tdb.db), site, assetsDir: null });
      const recovered = recording({ ...setup(posts), storage, newsApi, builder });
      await syncSite(recovered.deps);
      expect(recovered.rendered).toEqual(expect.arrayContaining(["static", "home", "post:K1"])); // footer ⇒ every page; theme/banner via static
      const marker = JSON.parse(await readFile(join(r.dir, ".site-state.json"), "utf8"));
      expect(r.settingsHashes(marker)).toEqual(settingsHashes(document, "America/Vancouver", new Date()));
      expect(r.settingsHashes(marker)).toEqual(r.settingsHashes(r.before));
      expect(await readFile(join(r.dir, "releases/K1/index.html"), "utf8")).toContain("Published Holder");
      expect(await readFile(join(r.dir, "assets/theme.css"), "utf8")).toContain(`--color-primary: ${document.theme.colors.primary};`);
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

    it("a footer change rewrites subscribe/index.html (and the other subscribe pages) on the same turn", async () => {
      const deps = setup(new Map([["K1", post({ key: "K1" })]]));
      api(deps).settings = published(withHolder("Old Holder"));
      await syncSite(deps);
      await (deps.storage as ReturnType<typeof memoryStorage>).write("subscribe/index.html", "stale");
      api(deps).settings = published(withHolder("New Holder"), 2);
      await syncSite(deps);
      for (const p of ["subscribe/index.html", "subscribe/manage/index.html", "subscribe/unsubscribe/index.html"]) expect(html(deps, p)).toContain("New Holder");
    });

    it("the cold-start defaults (no marker) write the subscribe pages with the defaults' footer", async () => {
      const deps = { ...setup(new Map([["K1", post({ key: "K1" })]])), defaultSettings: withHolder("Tenant Default Holder") };
      await syncSite(deps);
      expect(html(deps, "subscribe/index.html")).toContain("Tenant Default Holder");
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

    it("a connect change to other networks rebuilds only the Connect page and home (its Connect With Us icons), no release page", async () => {
      const deps = setup(new Map([["K1", post({ key: "K1" })]]));
      api(deps).settings = published(bcSettings());
      await syncSite(deps);
      expect(html(deps, "index.html")).toContain("threads_logo.svg");
      const doc = bcSettings();
      doc.connect.threads = { featured: [], accounts: [] };
      doc.connect.bluesky.accounts = [...doc.connect.bluesky.accounts, { text: "@NewBluesky", url: "https://bsky.app/profile/new" }];
      api(deps).settings = published(doc, 2);
      const r = recording(deps);
      await syncSite(r.deps);
      // The sector, theme and tag pages carry the strip too (here the one tag K1 has), then the four indexes.
      expect(r.rendered).toEqual(["connect", "home", ...KIND_IDS, "category:tags:covid-19", ...INDEX_IDS]);
      expect(html(deps, "connect/index.html")).toContain("@NewBluesky");
      expect(html(deps, "index.html")).not.toContain("threads_logo.svg");
    });

    it("a ministryPages-only change rebuilds the ministry pages and every release page (its labels), posts at bulk priority", async () => {
      const deps = setup(new Map([["K1", post({ key: "K1" })], ["K2", post({ key: "K2" })]]));
      api(deps).settings = published(bcSettings());
      await syncSite(deps);
      const doc = bcSettings();
      doc.ministryPages.mediaContacts = "Press Desk";
      api(deps).settings = published(doc, 2);
      const chrome = vi.spyOn(rebuildAll, "enqueueChromeChanges");
      const enqueue = vi.spyOn(queue, "enqueuePages");
      try {
        const r = recording(deps);
        await syncSite(r.deps);
        // What the settings change itself queued (a re-rendered post then queues its own
        // dependents — home, archives, sitemaps — as any post render does).
        expect(enqueue.mock.calls[0]![1]).toEqual([
          { pageId: "category:ministries:finance", priority: PRIORITY.liveAggregate },
          { pageId: "category:ministries:health", priority: PRIORITY.liveAggregate },
          { pageId: "post:K1", priority: PRIORITY.bulkPost },
          { pageId: "post:K2", priority: PRIORITY.bulkPost },
        ]);
        expect(r.rendered).toEqual(expect.arrayContaining(["category:ministries:finance", "category:ministries:health", "post:K1", "post:K2"]));
        expect(r.rendered).not.toContain("connect");
        expect(html(deps, "releases/K1/index.html")).toContain("Press Desk");
        expect(chrome.mock.calls.filter(([, , c]) => c.all)).toHaveLength(0); // the sections path, not a rebuild-all
      } finally {
        chrome.mockRestore();
        enqueue.mockRestore();
      }
    });

    it("a change to the Share list's Instagram account rebuilds the Connect page, home and every release page", async () => {
      const deps = setup(new Map([["K1", post({ key: "K1" })], ["K2", post({ key: "K2" })]]));
      api(deps).settings = published(bcSettings());
      await syncSite(deps);
      expect(html(deps, "releases/K1/index.html")).toContain("governmentofbc");
      const doc = bcSettings();
      doc.connect.instagram = { featured: [{ text: "NewBCAccount", url: "https://www.instagram.com/newbcaccount/" }], accounts: [] };
      api(deps).settings = published(doc, 2);
      const enqueue = vi.spyOn(queue, "enqueuePages");
      const r = recording(deps);
      try {
        await syncSite(r.deps);
        expect(enqueue.mock.calls[0]![1]).toEqual([
          { pageId: "connect", priority: PRIORITY.liveAggregate },
          { pageId: "home", priority: PRIORITY.liveAggregate },
          ...KIND_IDS.map((pageId) => ({ pageId, priority: PRIORITY.liveAggregate })),
          { pageId: "category:tags:covid-19", priority: PRIORITY.bulkAggregate },
          ...INDEX_IDS.map((pageId) => ({ pageId, priority: PRIORITY.bulkAggregate })),
          { pageId: "post:K1", priority: PRIORITY.bulkPost },
          { pageId: "post:K2", priority: PRIORITY.bulkPost },
        ]);
      } finally {
        enqueue.mockRestore();
      }
      expect(r.rendered).toEqual(expect.arrayContaining(["connect", "home", "post:K1", "post:K2"]));
      expect(html(deps, "releases/K2/index.html")).toContain("https://www.instagram.com/newbcaccount/");
      expect(html(deps, "releases/K2/index.html")).not.toContain("governmentofbc");
    });

    describe("land acknowledgement (chrome v7)", () => {
      const preField = () => {
        const d = bcSettings();
        delete d.footer.landAcknowledgement;
        return d;
      };
      const BC_ACK = bcSettings().footer.landAcknowledgement!;

      it("a published document without the field shows the tenant default text", async () => {
        const deps = { ...setup(new Map([["K1", post({ key: "K1" })]])), defaultSettings: bcSettings() };
        api(deps).settings = published(preField());
        await syncSite(deps);
        for (const p of ["index.html", "releases/K1/index.html", "subscribe/index.html"]) {
          expect(html(deps, p)).toContain('<aside id="landAcknowledgement" class="container-fluid" aria-label="Land acknowledgement">');
          expect(html(deps, p)).toContain(BC_ACK);
        }
      });

      it("deploying v7 with a filled default queues exactly one rebuild-all; the next turn queues nothing", async () => {
        const deps = { ...setup(new Map([["K1", post({ key: "K1" })], ["K2", post({ key: "K2" })], ["K3", post({ key: "K3" })]]), 1), defaultSettings: bcSettings() };
        const storage = deps.storage as ReturnType<typeof memoryStorage>;
        api(deps).settings = published(preField());
        await syncSite(deps);
        // The marker a v6 build left: chrome 6 and the footer hash of the unfilled document.
        const v6 = { ...JSON.parse(storage.files.get(".site-state.json") as string), chrome: 6, footerHash: settingsHashes(preField(), DEFAULT_TIME_ZONE, new Date()).footerHash };
        await storage.write(".site-state.json", JSON.stringify(v6));
        await tdb.pool.query("TRUNCATE rebuild_queue RESTART IDENTITY");
        // The queue de-duplicates by page id, so count the rebuild-all requests themselves.
        const chrome = vi.spyOn(rebuildAll, "enqueueChromeChanges");
        const rebuildAlls = () => chrome.mock.calls.filter(([, , c]) => c.all).length;
        try {
          await syncSite(deps);
          expect(rebuildAlls()).toBe(1);
          const q = new Set((await tdb.pool.query("SELECT page_id FROM rebuild_queue")).rows.map((r: { page_id: string }) => r.page_id));
          for (const id of ["post:K1", "post:K2", "post:K3", "archive", "sitemap"]) expect(q.has(id)).toBe(true);
          const marker = JSON.parse(storage.files.get(".site-state.json") as string);
          expect(marker.chrome).toBe(RENDER_CHROME_VERSION);
          expect(marker.footerHash).toBe(settingsHashes(bcSettings(), DEFAULT_TIME_ZONE, new Date()).footerHash);
          await tdb.pool.query("TRUNCATE rebuild_queue RESTART IDENTITY");
          await syncSite(deps);
          expect(await queueDepth(tdb.db)).toBe(0);
          expect(rebuildAlls()).toBe(1); // still the one: the next turn asked for none
        } finally {
          chrome.mockRestore();
        }
      });
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

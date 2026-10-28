import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { TestDatabase } from "@gcpe/db-kit";
import type { EventEnvelope } from "@gcpe/events";
import { createPublicSiteTestDb } from "../test/helpers";
import { fakeNewsApi, type FakeNewsApi } from "../test/fake-news-api";
import { memoryStorage } from "../test/memory-storage";
import { bcSettings, post, site } from "../test/fixtures";
import { prePlan4Settings } from "../../../packages/site-settings/src/fixtures";
import type { SiteStorage } from "./storage";
import type { PostDto } from "./dto";
import { createSiteBuilder } from "./builder";
import { postIndex } from "./post-index";
import * as queue from "./queue";
import { PRIORITY, queueDepth } from "./queue";
import { chromeChanges, enqueueSiteWrite, RENDER_CHROME_VERSION, stateAndBanner, writeSiteState } from "./rebuild";
import { createRebuildHandler, kickBackgroundSync, syncSite, type SyncDeps } from "./sync";

function envelope(data: unknown): EventEnvelope {
  return {
    id: "00000000-0000-0000-0000-000000000001",
    type: "site.rebuild_requested",
    version: 1,
    source: "news-api",
    aggregateId: "site",
    sequence: 1,
    occurredAt: new Date().toISOString(),
    correlationId: "00000000-0000-0000-0000-000000000002",
    data,
  };
}

describe("createRebuildHandler", () => {
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

  // I1: the handler only does quick work inside the receiver's own transaction — enqueue the
  // event's pages at live priority — and must never touch the News API or the builder itself.
  // That's what used to hold a pool connection for a whole drain, once concurrent deliveries
  // piled up behind one.
  it("enqueues the event's pages at live priority inside the given transaction, and renders nothing itself", async () => {
    const posts = new Map([["K1", post({ key: "K1" })]]);
    const deps = setup(posts);
    const homeSpy = vi.spyOn(deps.newsApi, "home");
    const handler = createRebuildHandler(deps);
    await tdb.db.transaction((tx) => handler(tx, envelope({ pages: ["home", "post:K1"] })));

    const storage = deps.storage as ReturnType<typeof memoryStorage>;
    expect(storage.files.size).toBe(0); // nothing rendered by the handler itself
    expect(homeSpy).not.toHaveBeenCalled(); // no News API call from the handler itself
    expect(await queueDepth(tdb.db)).toBe(2);
  });

  it("an event with no pages enqueues nothing", async () => {
    const deps = setup();
    const handler = createRebuildHandler(deps);
    await tdb.db.transaction((tx) => handler(tx, envelope({ pages: [] })));
    expect(await queueDepth(tdb.db)).toBe(0);
  });

  it("its enqueue rolls back with the rest of the transaction, same as any other write in it", async () => {
    const deps = setup();
    const handler = createRebuildHandler(deps);
    await expect(
      tdb.db.transaction(async (tx) => {
        await handler(tx, envelope({ pages: ["home"] }));
        throw new Error("something else in this transaction failed");
      }),
    ).rejects.toThrow("something else in this transaction failed");
    expect(await queueDepth(tdb.db)).toBe(0);
  });
});

describe("settings sections: contactsPage", () => {
  let tdb: TestDatabase;
  beforeAll(async () => { tdb = await createPublicSiteTestDb(); });
  afterAll(async () => { await tdb.drop(); });
  beforeEach(async () => { await tdb.pool.query("TRUNCATE site_posts"); await tdb.pool.query("TRUNCATE rebuild_queue RESTART IDENTITY"); });

  it("a contactsPage edit queues exactly contacts and the sitemap pages", async () => {
    const storage = memoryStorage();
    const newsApi = fakeNewsApi(new Map([["K1", post({ key: "K1" })]]));
    const index = postIndex(tdb.db);
    const builder = createSiteBuilder({ newsApi, storage, index, site, assetsDir: null });
    const deps: SyncDeps = { db: tdb.db, builder, index, newsApi, storage, site, test: false, batch: 200 };
    (newsApi as FakeNewsApi).settings = { revision: 1, document: bcSettings() };
    await syncSite(deps);
    expect(storage.files.get("contacts/index.html")).toContain("Contact List for Media");
    const doc = bcSettings();
    doc.contactsPage.listHeading = "Media list";
    (newsApi as FakeNewsApi).settings = { revision: 2, document: doc };
    const enqueue = vi.spyOn(queue, "enqueuePages");
    try {
      await syncSite(deps);
      expect(enqueue).toHaveBeenCalledTimes(1);
      // The HTML sitemap names the page by its heading, so it is re-rendered with it.
      expect(enqueue.mock.calls[0]![1]).toEqual([{ pageId: "contacts", priority: PRIORITY.liveAggregate }, { pageId: "sitemap:pages", priority: PRIORITY.liveAggregate }]);
      expect(storage.files.get("contacts/index.html")).toContain("Media list");
    } finally {
      enqueue.mockRestore();
    }
  });
});

describe("settings sections: pageText", () => {
  let tdb: TestDatabase;
  beforeAll(async () => { tdb = await createPublicSiteTestDb(); });
  afterAll(async () => { await tdb.drop(); });
  beforeEach(async () => { await tdb.pool.query("TRUNCATE site_posts"); await tdb.pool.query("TRUNCATE rebuild_queue RESTART IDENTITY"); });

  /** Syncs the BC settings, then an edited copy; returns the items the second sync queued (`items`)
   * and any later enqueue calls of the drain that followed (`dependents`). */
  async function edit(change: (d: ReturnType<typeof bcSettings>) => void) {
    const storage = memoryStorage();
    const newsApi = fakeNewsApi(new Map([["K1", post({ key: "K1", hasMediaAssets: true })], ["K2", post({ key: "K2" })]]));
    const index = postIndex(tdb.db);
    const builder = createSiteBuilder({ newsApi, storage, index, site, assetsDir: null });
    const deps: SyncDeps = { db: tdb.db, builder, index, newsApi, storage, site, test: false, batch: 200 };
    (newsApi as FakeNewsApi).settings = { revision: 1, document: bcSettings() };
    await syncSite(deps);
    expect(storage.files.get("privacy/index.html")).toContain("B.C. Government Website Privacy Statement");
    const doc = bcSettings();
    change(doc);
    (newsApi as FakeNewsApi).settings = { revision: 2, document: doc };
    const enqueue = vi.spyOn(queue, "enqueuePages");
    try {
      await syncSite(deps);
      // The sync enqueues once; any later call is the drain queueing a rebuilt post's dependents.
      const [first, ...later] = enqueue.mock.calls.map((c) => c[1] as { pageId: string; priority: number }[]);
      return { items: first!, dependents: later, storage };
    } finally {
      enqueue.mockRestore();
    }
  }

  it("a published document with no pageText at all renders privacy, 404 and the licence line from the tenant defaults", async () => {
    const storage = memoryStorage();
    const newsApi = fakeNewsApi(new Map([["K1", post({ key: "K1", hasMediaAssets: true })]]));
    const index = postIndex(tdb.db);
    const builder = createSiteBuilder({ newsApi, storage, index, site, assetsDir: null });
    // The BC tenant file as the defaults, as start.ts loads them (loadSiteSettingsDefaults).
    const deps: SyncDeps = { db: tdb.db, builder, index, newsApi, storage, site, test: false, batch: 200, defaultSettings: bcSettings() };
    (newsApi as FakeNewsApi).settings = { revision: 1, document: prePlan4Settings() };
    await syncSite(deps);
    const defaults = bcSettings().pageText;
    expect(storage.files.get("privacy/index.html")).toContain(`<h1>${defaults.privacy.title}</h1>`);
    expect(storage.files.get("404.html")).toContain("<h1>That web page doesn&#39;t exist.</h1>");
    expect(storage.files.get("releases/K1/index.html")).toContain(`>${defaults.assetLicence.linkText}</a>.</p>`);
  });

  it("a privacy edit queues exactly privacy", async () => {
    const { items, dependents, storage } = await edit((d) => { d.pageText.privacy.title = "Our privacy promise"; });
    expect(dependents).toEqual([]);
    expect(items).toEqual([{ pageId: "privacy", priority: PRIORITY.liveAggregate }]);
    expect(storage.files.get("privacy/index.html")).toContain("Our privacy promise");
  });

  it("a pageText.live edit queues exactly live", async () => {
    const { items, dependents, storage } = await edit((d) => { d.pageText.live.heading = "Watch live"; });
    expect(dependents).toEqual([]);
    expect(items).toEqual([{ pageId: "live", priority: PRIORITY.liveAggregate }]);
    expect(storage.files.get("live/index.html")).toContain("Watch live");
  });

  it("a pageText.searchArchiveLinks edit queues exactly search", async () => {
    const { items, dependents, storage } = await edit((d) => { d.pageText.searchArchiveLinks[0]!.text = "Older news, 2009 to 2011"; });
    expect(dependents).toEqual([]);
    expect(items).toEqual([{ pageId: "search", priority: PRIORITY.liveAggregate }]);
    expect(storage.files.get("search/index.html")).toContain("Older news, 2009 to 2011");
  });

  it("a collectionNotice or subscribeHelp edit rewrites the subscribe pages and queues nothing", async () => {
    for (const [change, text] of [
      [(d: ReturnType<typeof bcSettings>) => { d.pageText.collectionNotice.heading = "Collecting your details"; }, "Collecting your details"],
      [(d: ReturnType<typeof bcSettings>) => { d.pageText.subscribeHelpHtml = "<p>Ring the helpline</p>"; }, "Ring the helpline"],
    ] as const) {
      const storage = memoryStorage();
      const newsApi = fakeNewsApi(new Map([["K1", post({ key: "K1" })]]));
      const index = postIndex(tdb.db);
      const builder = createSiteBuilder({ newsApi, storage, index, site, assetsDir: null });
      const deps: SyncDeps = { db: tdb.db, builder, index, newsApi, storage, site, test: false, batch: 200 };
      (newsApi as FakeNewsApi).settings = { revision: 1, document: bcSettings() };
      await syncSite(deps);
      expect(storage.files.get("subscribe/index.html")).not.toContain(text);
      const doc = bcSettings();
      change(doc);
      (newsApi as FakeNewsApi).settings = { revision: 2, document: doc };
      const enqueue = vi.spyOn(queue, "enqueuePages");
      try {
        await syncSite(deps);
        expect(enqueue).not.toHaveBeenCalled();
        expect(storage.files.get("subscribe/index.html")).toContain(text);
        expect(storage.files.get("subscribe/manage/index.html")).toBeDefined();
      } finally {
        enqueue.mockRestore();
      }
    }
  });

  it("a notFound edit queues exactly static", async () => {
    const { items, dependents, storage } = await edit((d) => { d.pageText.notFound.heading = "Nothing here"; });
    expect(dependents).toEqual([]);
    expect(items).toEqual([{ pageId: "static", priority: PRIORITY.liveAggregate }]);
    expect(storage.files.get("404.html")).toContain("Nothing here");
  });

  it("an assetLicence edit queues every post and nothing else", async () => {
    const { items, dependents, storage } = await edit((d) => { d.pageText.assetLicence.linkText = "Footage licence v2"; });
    expect(items.map((i) => i.pageId).sort()).toEqual(["post:K1", "post:K2"]);
    expect(items.every((i) => i.priority === PRIORITY.bulkPost)).toBe(true);
    // Each rebuilt post queues its dependents at bulk-aggregate priority (drain), never the sync again.
    expect(dependents.flat().every((i) => i.priority === PRIORITY.bulkAggregate)).toBe(true);
    expect(storage.files.get("releases/K1/index.html")).toContain("Footage licence v2");
  });
});

describe("kickBackgroundSync", () => {
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

  it("drains what the handler enqueued, the same as a tick would", async () => {
    const posts = new Map([["K1", post({ key: "K1" })]]);
    const deps = setup(posts);
    const handler = createRebuildHandler(deps);
    await tdb.db.transaction((tx) => handler(tx, envelope({ pages: ["home", "post:K1"] })));

    await kickBackgroundSync(deps);

    const storage = deps.storage as ReturnType<typeof memoryStorage>;
    expect(storage.files.has("index.html")).toBe(true);
    expect(storage.files.has("releases/K1/index.html")).toBe(true);
    expect(await queueDepth(tdb.db)).toBe(0);
  });

  // Mirrors sync.test.ts's "single-flights deps.feed" test, one level up: a storm of events each
  // calling this after their own transaction commits must not turn into a storm of syncSite
  // turns (I1's realistic trigger). Gated on `deps.feed`, not `newsApi.home` — a single turn can
  // legitimately call `home()` more than once (the chrome check, then again while rendering the
  // "home" page itself), so `feed` is the one call `syncSite` makes exactly once per turn.
  it("single-flights: 10 concurrent calls while one is running produce at most 2 syncSite turns", async () => {
    const deps = setup();
    let calls = 0;
    let releaseFirst!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const feed = vi.fn(async () => {
      calls++;
      if (calls === 1) await gate;
      return { changes: 0, resynced: false };
    });
    const depsWithFeed = { ...deps, feed };

    const runs = Array.from({ length: 10 }, () => kickBackgroundSync(depsWithFeed));
    releaseFirst();
    await Promise.all(runs);
    expect(calls).toBeLessThanOrEqual(2);
  });

  // safeErrorLabel never carries the error's own message (only `.code` or `.name`) — the log
  // line here must say so without it, same as everywhere else this codebase logs a caught error.
  it("a failed turn is caught and logged with safeErrorLabel and the route, not thrown — the page stays queued for the next run", async () => {
    const deps = setup();
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const handler = createRebuildHandler(deps);
    await tdb.db.transaction((tx) => handler(tx, envelope({ pages: ["home"] })));
    deps.newsApi.home = async () => {
      throw new Error("News API down");
    };

    await expect(kickBackgroundSync(deps)).resolves.toBeUndefined(); // never an unhandled rejection

    expect(errSpy).toHaveBeenCalledWith("[public-site] background site sync failed (POST /events) Error");
    expect(await queueDepth(tdb.db)).toBeGreaterThan(0); // never rendered, never lost
    errSpy.mockRestore();
  });
});

describe("enqueueSiteWrite", () => {
  it("serialises turns in enqueue order: the second's task function doesn't even start until the first's turn has fully settled", async () => {
    const storage = memoryStorage();
    const order: string[] = [];
    let releaseFirst: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => (releaseFirst = resolve));

    const p1 = enqueueSiteWrite(storage, async () => {
      order.push("start1");
      await gate;
      order.push("end1");
    });
    const p2 = enqueueSiteWrite(storage, async () => {
      order.push("start2");
      order.push("end2");
    });

    expect(order).toEqual([]);
    releaseFirst!();
    await Promise.all([p1, p2]);
    expect(order).toEqual(["start1", "end1", "start2", "end2"]);
  });
});

describe("RENDER_CHROME_VERSION", () => {
  // 6: the legacy <head> (favicon, html.js marker, vendored legacy CSS, overrides.css, theme aliases).
  // 7: the news.gov header (logo, News ministry menu, Subscribe, search, phone drawer) and site.js.
  // 8: the archive by government term (new-government Task 6).
  // 9: the news.gov home page (carousel band, PostCards, Load More, Connect With Us, News by Sector).
  // 10: the news.gov release page, minister card, biography page and ministry page (parity plan 2).
  // 19: card file links only when a list is non-empty (legacy file import).
  it("RENDER_CHROME_VERSION is 20", () => expect(RENDER_CHROME_VERSION).toBe(20));
});

describe("Search Console verification in the render-state marker", () => {
  const verified = { ...site, verification: { googleFile: "google790b0529c8dcfaff.html", googleMeta: "ss-eO0gSqB1_GY5aWryEXVmGQBHJgpe9-hdwcskzjss" } };
  const state = () => stateAndBanner(null, false, new Date("2026-10-28T12:00:00Z"), bcSettings(), site, []).state;
  const marked = async (s: typeof site) => {
    const storage = memoryStorage();
    await writeSiteState(storage as SiteStorage, state(), s);
    return storage;
  };
  it("setting, changing or clearing SITE_GOOGLE_* queues exactly the static page and home, not a rebuild-all", async () => {
    expect(await chromeChanges(await marked(site) as SiteStorage, state(), site)).toMatchObject({ all: false, sections: [] });
    expect(await chromeChanges(await marked(site) as SiteStorage, state(), verified)).toMatchObject({ all: false, sections: ["static", "home"] });
    const changed = { ...verified, verification: { ...verified.verification, googleMeta: "another-token-0123456789abcdef" } };
    expect(await chromeChanges(await marked(verified) as SiteStorage, state(), changed)).toMatchObject({ all: false, sections: ["static", "home"] });
    expect(await chromeChanges(await marked(verified) as SiteStorage, state(), site)).toMatchObject({ all: false, sections: ["static", "home"] });
    expect(await chromeChanges(await marked(verified) as SiteStorage, state(), verified)).toMatchObject({ all: false, sections: [] });
  });
  it("a marker written before verification existed reads as none", async () => {
    const storage = await marked(site);
    const old = JSON.parse(storage.files.get(".site-state.json") as string);
    delete old.verification;
    storage.files.set(".site-state.json", JSON.stringify(old));
    expect(await chromeChanges(storage as SiteStorage, state(), site)).toMatchObject({ all: false, sections: [] });
  });
});

describe("Navigation settings in the render-state marker", () => {
  const stateFor = (mutate: (s: ReturnType<typeof bcSettings>) => void = () => {}) => {
    const s = bcSettings();
    mutate(s);
    return stateAndBanner(null, false, new Date("2026-10-28T12:00:00Z"), s, site, []).state;
  };
  const marked = async () => {
    const storage = memoryStorage();
    await writeSiteState(storage as SiteStorage, stateFor(), site);
    return storage as SiteStorage;
  };

  it("a headerLinks edit is a rebuild-all (so are the News, Live and footer-heading labels and the search switch)", async () => {
    expect(await chromeChanges(await marked(), stateFor(), site)).toMatchObject({ all: false, sections: [] });
    for (const m of [
      (s: ReturnType<typeof bcSettings>) => { s.navigation.headerLinks.push({ text: "Extra", url: "/extra/" }); },
      (s: ReturnType<typeof bcSettings>) => { s.navigation.newsLabel = "Newsroom"; },
      (s: ReturnType<typeof bcSettings>) => { s.navigation.liveLabel = "Webcast"; },
      (s: ReturnType<typeof bcSettings>) => { s.navigation.showHeaderSearch = false; },
      (s: ReturnType<typeof bcSettings>) => { s.navigation.footerMoreInfoHeading = "Other"; },
    ]) expect(await chromeChanges(await marked(), stateFor(m), site)).toMatchObject({ all: true });
  });

  it("a labels or listing-title edit is the labels section, not a rebuild-all", async () => {
    expect(await chromeChanges(await marked(), stateFor((s) => { s.navigation.labels.searchNews = "Find"; }), site)).toMatchObject({ all: false, sections: ["labels"] });
    expect(await chromeChanges(await marked(), stateFor((s) => { s.navigation.listingTitles.stories = "Features"; }), site)).toMatchObject({ all: false, sections: ["labels"] });
  });

  it("a marker written before headerHash and labelsHash existed reads as changed", async () => {
    const storage = memoryStorage();
    await writeSiteState(storage as SiteStorage, stateFor(), site);
    const old = JSON.parse(storage.files.get(".site-state.json") as string);
    delete old.headerHash;
    delete old.labelsHash;
    storage.files.set(".site-state.json", JSON.stringify(old));
    expect(await chromeChanges(storage as SiteStorage, stateFor(), site)).toMatchObject({ all: true });
  });
});

describe("Site identity in the render-state marker", () => {
  const stateFor = (mutate: (s: ReturnType<typeof bcSettings>) => void = () => {}) => {
    const s = bcSettings();
    mutate(s);
    return stateAndBanner(null, false, new Date("2026-10-28T12:00:00Z"), s, site, []).state;
  };
  const marked = async () => {
    const storage = memoryStorage();
    await writeSiteState(storage as SiteStorage, stateFor(), site);
    return storage;
  };

  it("a siteIdentity description edit queues a rebuild of every page (all); so does the X account", async () => {
    expect(await chromeChanges(await marked() as SiteStorage, stateFor(), site)).toMatchObject({ all: false, sections: [] });
    expect(await chromeChanges(await marked() as SiteStorage, stateFor((s) => { s.siteIdentity.description = "A new description"; }), site)).toMatchObject({ all: true });
    expect(await chromeChanges(await marked() as SiteStorage, stateFor((s) => { s.siteIdentity.twitterSite = "Other"; }), site)).toMatchObject({ all: true });
  });

  it("a Blue Bridge text edit (not part of the identity hash) does not queue a rebuild-all", async () => {
    const r = await chromeChanges(await marked() as SiteStorage, stateFor((s) => { s.siteIdentity.blueBridge.message = "Changed {age}"; }), site);
    expect(r.all).toBe(false);
  });

  it("a Blue Bridge text edit while the switch is off queues nothing", async () => {
    const off = (m: (s: ReturnType<typeof bcSettings>) => void = () => {}) => { const s = bcSettings(); m(s); return stateAndBanner("false", false, new Date("2026-10-28T12:00:00Z"), s, site, []).state; };
    const storage = memoryStorage();
    await writeSiteState(storage as SiteStorage, off(), site);
    expect(await chromeChanges(storage as SiteStorage, off((s) => { s.siteIdentity.blueBridge.message = "Changed {age}"; s.siteIdentity.blueBridge.birthDate = "1950-01-01"; }), site)).toMatchObject({ all: false, sections: [] });
  });

  it("a Blue Bridge text edit while the switch is on queues every page", async () => {
    const on = (m: (s: ReturnType<typeof bcSettings>) => void = () => {}) => { const s = bcSettings(); m(s); return stateAndBanner("true", false, new Date("2026-10-28T12:00:00Z"), s, site, []).state; };
    const storage = memoryStorage();
    await writeSiteState(storage as SiteStorage, on(), site);
    expect(await chromeChanges(storage as SiteStorage, on(), site)).toMatchObject({ all: false, sections: [] });
    expect(await chromeChanges(storage as SiteStorage, on((s) => { s.siteIdentity.blueBridge.message = "Changed {age}"; }), site)).toMatchObject({ all: true });
    expect(await chromeChanges(storage as SiteStorage, on((s) => { s.siteIdentity.blueBridge.birthDate = "1950-01-01"; }), site)).toMatchObject({ all: true });
  });

  it("an old marker without blueBridgeTextHash: switch off queues nothing; switch on queues one rebuild, then none", async () => {
    const strip = (storage: ReturnType<typeof memoryStorage>) => {
      const old = JSON.parse(storage.files.get(".site-state.json") as string);
      delete old.blueBridgeTextHash;
      storage.files.set(".site-state.json", JSON.stringify(old));
    };
    const st = (g: string) => stateAndBanner(g, false, new Date("2026-10-28T12:00:00Z"), bcSettings(), site, []).state;
    const offStore = memoryStorage();
    await writeSiteState(offStore as SiteStorage, st("false"), site);
    strip(offStore);
    expect(await chromeChanges(offStore as SiteStorage, st("false"), site)).toMatchObject({ all: false, sections: [] });
    const onStore = memoryStorage();
    await writeSiteState(onStore as SiteStorage, st("true"), site);
    strip(onStore);
    expect(await chromeChanges(onStore as SiteStorage, st("true"), site)).toMatchObject({ all: true });
    await writeSiteState(onStore as SiteStorage, st("true"), site);
    expect(await chromeChanges(onStore as SiteStorage, st("true"), site)).toMatchObject({ all: false, sections: [] });
  });

  it("a marker written before identityHash existed queues one rebuild-all, and the next turn none", async () => {
    const storage = await marked();
    const old = JSON.parse(storage.files.get(".site-state.json") as string);
    delete old.identityHash;
    storage.files.set(".site-state.json", JSON.stringify(old));
    expect(await chromeChanges(storage as SiteStorage, stateFor(), site)).toMatchObject({ all: true });
    await writeSiteState(storage as SiteStorage, stateFor(), site);
    expect(await chromeChanges(storage as SiteStorage, stateFor(), site)).toMatchObject({ all: false, sections: [] });
  });
});

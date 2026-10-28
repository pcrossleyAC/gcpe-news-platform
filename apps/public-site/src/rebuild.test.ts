import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { TestDatabase } from "@gcpe/db-kit";
import type { EventEnvelope } from "@gcpe/events";
import { createPublicSiteTestDb } from "../test/helpers";
import { fakeNewsApi } from "../test/fake-news-api";
import { memoryStorage } from "../test/memory-storage";
import { post, site } from "../test/fixtures";
import type { PostDto } from "./dto";
import { createSiteBuilder } from "./builder";
import { postIndex } from "./post-index";
import { queueDepth } from "./queue";
import { enqueueSiteWrite, RENDER_CHROME_VERSION } from "./rebuild";
import { createRebuildHandler, kickBackgroundSync, type SyncDeps } from "./sync";

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
  // 8: the news.gov home page (carousel band, PostCards, Load More, Connect With Us, News by Sector).
  it("RENDER_CHROME_VERSION is 8", () => expect(RENDER_CHROME_VERSION).toBe(8));
});

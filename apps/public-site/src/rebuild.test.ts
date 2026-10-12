import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { TestDatabase, Tx } from "@gcpe/db-kit";
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
import { createRebuildHandler, type SyncDeps } from "./sync";

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

  it("a home() failure propagates: the handler rejects and writes nothing", async () => {
    const deps = setup();
    deps.newsApi.home = async () => {
      throw new Error("News API down");
    };
    const handler = createRebuildHandler(deps);
    await expect(handler({} as Tx, envelope({ pages: ["home"] }))).rejects.toThrow("News API down");
    expect((deps.storage as ReturnType<typeof memoryStorage>).files.size).toBe(0);
  });

  it("an event's pages are queued live and rendered in the same turn", async () => {
    const posts = new Map([["K1", post({ key: "K1" })]]);
    const deps = setup(posts);
    const handler = createRebuildHandler(deps);
    await handler({} as Tx, envelope({ pages: ["home", "post:K1"] }));
    const storage = deps.storage as ReturnType<typeof memoryStorage>;
    expect(storage.files.has("index.html")).toBe(true);
    expect(storage.files.has("releases/K1/index.html")).toBe(true);
    expect(await queueDepth(tdb.db)).toBe(0);
  });

  it("a chrome change queues a full rebuild, writes the marker, and renders home on the same run", async () => {
    const posts = new Map([["K1", post({ key: "K1" })]]);
    const deps = setup(posts, 5);
    await deps.storage.write(".site-state.json", JSON.stringify({ granvilleOn: false, test: false, chrome: 2, baseUrl: site.baseUrl }));
    const handler = createRebuildHandler(deps);
    await handler({} as Tx, envelope({ pages: [] }));
    const storage = deps.storage as ReturnType<typeof memoryStorage>;
    expect(storage.files.has("index.html")).toBe(true);
    expect(JSON.parse(storage.files.get(".site-state.json") as string).chrome).toBe(RENDER_CHROME_VERSION);
    expect(await queueDepth(tdb.db)).toBeGreaterThan(0);
  });

  describe("enqueueSiteWrite / rebuild serialisation", () => {
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

    it("two overlapping rebuilds with different granville — the later-enqueued one (OFF) wins the final pages and marker, and never interleaves with the first (ON)", async () => {
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
      const handler = createRebuildHandler(deps);

      const p1 = handler({} as Tx, envelope({ pages: ["post:K1"] }));
      const p2 = handler({} as Tx, envelope({ pages: ["post:K1"] }));

      releaseFirstHome!({ granville: "true", topPostKey: null, featurePostKey: null });
      await Promise.all([p1, p2]);

      const storage = deps.storage as ReturnType<typeof memoryStorage>;
      expect(order).toEqual(["start-home-1(ON, gated)", "end-home-1(ON)"]);
      expect(storage.files.get("releases/K1/index.html")).not.toContain("blue-bridge-banner");
      expect(storage.files.get("index.html")).not.toContain("blue-bridge-banner");
      expect(JSON.parse(storage.files.get(".site-state.json") as string)).toEqual({ granvilleOn: false, test: false, chrome: RENDER_CHROME_VERSION, baseUrl: site.baseUrl });
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
      const handler = createRebuildHandler(deps);

      const p1 = handler({} as Tx, envelope({ pages: ["post:K1"] }));
      const p2 = handler({} as Tx, envelope({ pages: ["post:K1"] }));
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
      const handler = createRebuildHandler(deps);
      await expect(handler({} as Tx, envelope({ pages: ["post:K1"] }))).rejects.toThrow("News API down");

      deps.newsApi.home = async () => ({ granville: null, topPostKey: null, featurePostKey: null });
      await expect(handler({} as Tx, envelope({ pages: ["post:K1"] }))).resolves.toBeUndefined();
      expect((deps.storage as ReturnType<typeof memoryStorage>).files.has("index.html")).toBe(true);
    });
  });
});

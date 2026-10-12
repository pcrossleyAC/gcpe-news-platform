import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type pg from "pg";
import { createDb, type Db, type TestDatabase } from "@gcpe/db-kit";
import { createApp } from "./app";
import { createPublicSiteTestDb, envelope, EVENT_SECRETS, sendEvent } from "../test/helpers";
import { createSiteBuilder } from "./builder";
import { fakeNewsApi } from "../test/fake-news-api";
import { memoryStorage } from "../test/memory-storage";
import { post, site } from "../test/fixtures";
import type { PostDto } from "./dto";
import { postIndex } from "./post-index";
import { enqueuePages, PRIORITY, queueDepth } from "./queue";
import { createRebuildHandler, kickBackgroundSync, type SyncDeps } from "./sync";

/**
 * I1: before the fix, each `site.rebuild_requested` handler awaited a whole `syncSite` turn
 * (drain included) from inside the receiver's own `db.transaction`, holding a pool connection
 * the entire time. With about nine concurrent deliveries against a real pool of 10, the turn at
 * the head of `enqueueSiteWrite`'s queue needed a fresh connection (the drain lock, plus
 * enqueue/render/complete queries) that the other nine had already exhausted, and every parked
 * handler then waited forever for that turn — the reviewer's probe saw no response in 40s at
 * 9–12 concurrent deliveries. This test reproduces that shape against a real Postgres pool
 * sized like the public site's own (`createDb`'s default `max: 10`, plus I1's
 * `connectionTimeoutMillis` so a wedge fails loudly instead of hanging): 12 concurrent
 * deliveries, a non-empty queue already waiting to drain. It only passes because the handler
 * now does nothing but enqueue inside the transaction (sync.ts's `createRebuildHandler`) and the
 * drain runs afterwards, kicked and single-flighted (`kickBackgroundSync`), never awaited by the
 * request path.
 */
describe("concurrent site.rebuild_requested deliveries against a real pool (I1)", () => {
  let tdb: TestDatabase;
  let pool: pg.Pool | undefined;

  beforeAll(async () => {
    tdb = await createPublicSiteTestDb();
  });
  afterAll(async () => {
    await tdb.drop();
  });
  afterEach(async () => {
    await pool?.end();
    pool = undefined;
  });

  it(
    "12 concurrent deliveries against a 30-page backlog all commit promptly, and the backlog still drains",
    async () => {
      // One pool, shared by the event receiver's transactions, the kicked drains and the
      // seeding/assertion queries below — exactly like the one process, one pool the real public
      // site runs (apps/public-site/src/start.ts).
      const created = createDb(tdb.url, { max: 10, connectionTimeoutMillis: 5_000 });
      pool = created.pool;
      const db: Db = created.db;

      const posts = new Map<string, PostDto>();
      for (let i = 0; i < 30; i++) posts.set(`K${i}`, post({ key: `K${i}` }));
      const storage = memoryStorage();
      const newsApi = fakeNewsApi(posts);
      const index = postIndex(db);
      const builder = createSiteBuilder({ newsApi, storage, index, site, assetsDir: null });
      const deps: SyncDeps = { db, builder, index, newsApi, storage, site, test: false, batch: 200 };
      const handler = createRebuildHandler(deps);
      const app = createApp({
        db,
        eventSecrets: EVENT_SECRETS,
        handler,
        onApplied: () => {
          void kickBackgroundSync(deps);
        },
      });

      // A non-empty backlog, like a ministry edit or a resync would leave queued — this is what
      // made the drain long enough for deliveries to pile up behind it in the reviewer's probe.
      await enqueuePages(
        db,
        Array.from({ length: 30 }, (_, i) => ({ pageId: `post:K${i}`, priority: PRIORITY.bulkPost })),
      );

      const events = Array.from({ length: 12 }, () => envelope("news-api", "site.rebuild_requested", { pages: ["home"] }));
      const started = Date.now();
      const responses = await Promise.all(events.map((event) => sendEvent(app, event)));
      const elapsedMs = Date.now() - started;

      for (const res of responses) expect(res.status).toBe(200);
      // Pre-fix, this hangs (or, with the pool's own connectionTimeoutMillis, fails after ~5s) —
      // the handler only enqueues now, so every delivery returns almost at once regardless of
      // how long the backlog takes to drain in the background.
      expect(elapsedMs).toBeLessThan(5_000);

      const deadline = Date.now() + 15_000;
      while ((await queueDepth(db)) > 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100));

      expect(await queueDepth(db)).toBe(0);
      for (let i = 0; i < 30; i++) expect(storage.files.has(`releases/K${i}/index.html`)).toBe(true);
      expect(storage.files.has("index.html")).toBe(true);
    },
    20_000,
  );
});

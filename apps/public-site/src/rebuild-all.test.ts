import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { TestDatabase } from "@gcpe/db-kit";
import { createPublicSiteTestDb } from "../test/helpers";
import { fakeNewsApi } from "../test/fake-news-api";
import { memoryStorage } from "../test/memory-storage";
import { post, site } from "../test/fixtures";
import { createSiteBuilder } from "./builder";
import { postIndex } from "./post-index";
import { nextBatch, PRIORITY } from "./queue";
import { enqueueRebuildAll } from "./rebuild-all";

describe("enqueueRebuildAll", () => {
  let tdb: TestDatabase;
  beforeAll(async () => { tdb = await createPublicSiteTestDb(); });
  afterAll(async () => { await tdb.drop(); });
  beforeEach(async () => { await tdb.pool.query("TRUNCATE site_posts"); await tdb.pool.query("TRUNCATE rebuild_queue RESTART IDENTITY"); });

  it("queues home, static and the indexes live, every post bulk (newest first), then every aggregate", async () => {
    const storage = memoryStorage();
    const api = fakeNewsApi();
    const builder = createSiteBuilder({ newsApi: api, storage, index: postIndex(tdb.db), site, assetsDir: null });
    api.posts.set("OLD", post({ key: "OLD", publishDate: "2026-01-01T09:00:00-08:00" }));
    api.posts.set("NEW", post({ key: "NEW", publishDate: "2026-10-01T09:00:00-07:00" }));
    await enqueueRebuildAll(tdb.db, builder);
    const batch = await nextBatch(tdb.db, 1000, []);
    const at = (p: number) => batch.filter((i) => i.priority === p).map((i) => i.pageId);
    expect(at(PRIORITY.liveAggregate)).toEqual(["static", "home", "ministries", "archive", "search", "sitemap"]);
    expect(at(PRIORITY.bulkPost)).toEqual(["post:NEW", "post:OLD"]);
    expect(at(PRIORITY.bulkAggregate)).toContain("sitemap:pages");
    expect(at(PRIORITY.bulkAggregate)).toContain("category:ministries:health");
  });
});

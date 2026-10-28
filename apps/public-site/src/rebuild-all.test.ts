import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { TestDatabase } from "@gcpe/db-kit";
import { createPublicSiteTestDb } from "../test/helpers";
import { fakeNewsApi } from "../test/fake-news-api";
import { memoryStorage } from "../test/memory-storage";
import { post, site } from "../test/fixtures";
import { createSiteBuilder } from "./builder";
import { postIndex } from "./post-index";
import { nextBatch, PRIORITY } from "./queue";
import { enqueueChromeChanges, enqueueRebuildAll } from "./rebuild-all";

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
    expect(at(PRIORITY.bulkAggregate)).toContain("connect");
    expect(at(PRIORITY.bulkAggregate)).toContain("privacy");
    expect(at(PRIORITY.bulkAggregate)).toContain("live");
    expect(at(PRIORITY.bulkAggregate)).toContain("category:ministries:health");
  });

  it("a connect settings change queues connect, home and the four kind listings", async () => {
    const builder = createSiteBuilder({ newsApi: fakeNewsApi(), storage: memoryStorage(), index: postIndex(tdb.db), site, assetsDir: null });
    await enqueueChromeChanges(tdb.db, builder, { all: false, sections: ["connect"] });
    const ids = (await nextBatch(tdb.db, 1000, [])).map((i) => i.pageId);
    expect(ids).toEqual(expect.arrayContaining(["connect", "home", "kind:releases", "kind:stories", "kind:factsheets", "kind:updates"]));
  });

  it("a connect settings change queues every sector, theme and tag page at bulk priority, no ministry page", async () => {
    const api = fakeNewsApi();
    const c = (kind: "sectors" | "themes" | "tags", key: string) => ({ key, kind, name: key, isActive: true, topPostKey: null, featurePostKey: null });
    api.sectors = [c("sectors", "economy")];
    api.themes = [c("themes", "housing")];
    api.tags = [c("tags", "covid-19")];
    const builder = createSiteBuilder({ newsApi: api, storage: memoryStorage(), index: postIndex(tdb.db), site, assetsDir: null });
    await enqueueChromeChanges(tdb.db, builder, { all: false, sections: ["connect"] });
    const batch = await nextBatch(tdb.db, 1000, []);
    for (const id of ["category:sectors:economy", "category:themes:housing", "category:tags:covid-19"]) expect(batch.find((i) => i.pageId === id)?.priority, id).toBe(PRIORITY.bulkAggregate);
    expect(batch.some((i) => i.pageId.startsWith("category:ministries:"))).toBe(false);
  });

  it("a connect settings change queues the four category indexes at bulk priority", async () => {
    const builder = createSiteBuilder({ newsApi: fakeNewsApi(), storage: memoryStorage(), index: postIndex(tdb.db), site, assetsDir: null });
    await enqueueChromeChanges(tdb.db, builder, { all: false, sections: ["connect"] });
    const batch = await nextBatch(tdb.db, 1000, []);
    for (const id of ["ministries", "index:sectors", "index:themes", "index:tags"]) expect(batch.find((i) => i.pageId === id)?.priority, id).toBe(PRIORITY.bulkAggregate);
  });

  it("a labels edit queues every aggregate page and no post", async () => {
    const storage = memoryStorage();
    const api = fakeNewsApi();
    const builder = createSiteBuilder({ newsApi: api, storage, index: postIndex(tdb.db), site, assetsDir: null });
    api.posts.set("K1", post({ key: "K1" }));
    await enqueueChromeChanges(tdb.db, builder, { all: false, sections: ["labels"] });
    const ids = (await nextBatch(tdb.db, 1000, [])).map((i) => i.pageId);
    expect(ids).toEqual(expect.arrayContaining(["static", "home", "ministries", "category:ministries:health", "sitemap:pages"]));
    expect(ids.some((id) => id.startsWith("post:"))).toBe(false);
  });
});

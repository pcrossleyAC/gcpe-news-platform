import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { TestDatabase } from "@gcpe/db-kit";
import { createPublicSiteTestDb } from "../test/helpers";
import { fakeNewsApi } from "../test/fake-news-api";
import { memoryStorage } from "../test/memory-storage";
import { post, site } from "../test/fixtures";
import { createSiteBuilder } from "./builder";
import type { PostDto } from "./dto";
import { postIndex } from "./post-index";

describe("site builder", () => {
  let tdb: TestDatabase;
  beforeAll(async () => { tdb = await createPublicSiteTestDb(); });
  afterAll(async () => { await tdb.drop(); });
  beforeEach(async () => { await tdb.pool.query("TRUNCATE site_posts"); });

  const setup = (posts: Map<string, PostDto>) => {
    const storage = memoryStorage();
    const api = fakeNewsApi(posts);
    const builder = createSiteBuilder({ newsApi: api, storage, index: postIndex(tdb.db), site, assetsDir: null });
    return { storage, api, builder };
  };
  const html = (s: ReturnType<typeof memoryStorage>, path: string) => String(s.files.get(path) ?? "");

  it("a published post: its page, then home, ministry, tag, month archive, archive index and sitemaps", async () => {
    const { storage, builder } = setup(new Map([["K1", post({ key: "K1", ministryKeys: ["Health"], tagKeys: ["covid-19"] })]]));
    await builder.rebuild(["home", "post:K1"], {});
    for (const f of ["releases/K1/index.html", "index.html", "feed.xml", "ministries/health/index.html", "ministries/health/feed.xml", "tags/covid-19/index.html", "archive/index.html", "archive/2026/10/index.html", "sitemap.xml", "sitemaps/2026-10.xml"]) {
      expect(storage.files.has(f), f).toBe(true);
    }
    expect(html(storage, "ministries/health/index.html")).toContain('href="/releases/K1/"');
    expect(html(storage, "archive/2026/10/index.html")).toContain('href="/releases/K1/"');
    expect(html(storage, "sitemaps/2026-10.xml")).toContain("https://news.example/releases/K1/");
  });

  it("an update that moves a post to another ministry takes it off the old ministry page", async () => {
    const posts = new Map([["K1", post({ key: "K1", ministryKeys: ["health"] })]]);
    const { storage, builder } = setup(posts);
    await builder.rebuild(["post:K1"], {});
    posts.set("K1", post({ key: "K1", ministryKeys: ["finance"], publishDate: "2026-11-02T10:00:00-07:00" }));
    await builder.rebuild(["post:K1"], {});
    expect(html(storage, "ministries/health/index.html")).not.toContain("/releases/K1/");
    expect(html(storage, "ministries/finance/index.html")).toContain("/releases/K1/");
    expect(storage.files.has("archive/2026/10/index.html")).toBe(false);
    expect(html(storage, "archive/2026/11/index.html")).toContain("/releases/K1/");
  });

  it("unpublishing removes the release page and its entries", async () => {
    const posts = new Map([["K1", post({ key: "K1" })], ["K2", post({ key: "K2", publishDate: "2026-09-01T10:00:00-07:00" })]]);
    const { storage, builder } = setup(posts);
    await builder.rebuild(["post:K1", "post:K2"], {});
    posts.delete("K1");
    await builder.rebuild(["post:K1"], {});
    expect(storage.files.has("releases/K1/index.html")).toBe(false);
    expect(storage.files.has("archive/2026/10/index.html")).toBe(false);
    expect(storage.files.has("sitemaps/2026-10.xml")).toBe(false);
    expect(html(storage, "archive/index.html")).not.toContain("October 2026");
    expect(html(storage, "index.html")).not.toContain("/releases/K1/");
    expect(html(storage, "ministries/health/index.html")).not.toContain("/releases/K1/");
    expect(html(storage, "sitemap.xml")).not.toContain("2026-10.xml");
  });

  it("a category the News API no longer has loses its page and feed", async () => {
    const { storage, builder } = setup(new Map());
    await storage.write("tags/gone/index.html", "x");
    await storage.write("tags/gone/feed.xml", "x");
    await builder.rebuild(["category:tags:gone"], {});
    expect(storage.files.has("tags/gone/index.html")).toBe(false);
    expect(storage.files.has("tags/gone/feed.xml")).toBe(false);
  });

  it("skips (and never writes for) an invalid page id", async () => {
    const { storage, builder } = setup(new Map());
    await builder.rebuild(["post:../../etc", "category:ministries:../x", "bogus"], {});
    expect(storage.files.size).toBe(0);
  });

  it("a News API key that differs from the requested one is skipped, not written", async () => {
    const { storage, builder } = setup(new Map([["K1", post({ key: ".." })]]));
    await builder.rebuild(["post:K1"], {});
    expect(storage.files.has("releases/K1/index.html")).toBe(false);
  });

  it("a related-posts failure doesn't block the release page", async () => {
    const { storage, api, builder } = setup(new Map([["K1", post({ key: "K1" })]]));
    api.related = async () => { throw new Error("News API 500"); };
    await builder.rebuild(["post:K1"], {});
    expect(storage.files.has("releases/K1/index.html")).toBe(true);
  });

  it("buildAll renders every published key, removes pages for keys no longer published, then every aggregate", async () => {
    const { storage, builder } = setup(new Map([["K1", post({ key: "K1" })], ["S1", post({ key: "S1", kind: "stories" })]]));
    await storage.write("releases/OLD/index.html", "stale");
    const r = await builder.buildAll({});
    expect(r).toEqual({ posts: 3, failures: 0 });
    expect(storage.files.has("releases/OLD/index.html")).toBe(false);
    for (const f of ["releases/K1/index.html", "releases/S1/index.html", "index.html", "ministries/index.html", "ministries/health/index.html", "ministries/finance/index.html", "archive/index.html", "sitemap.xml", "sitemaps/pages.xml", "assets/theme.css", "robots.txt", "404.html"]) {
      expect(storage.files.has(f), f).toBe(true);
    }
  });

  it("every generated HTML page passes the structure check", async () => {
    const { storage, builder } = setup(new Map([["K1", post({ key: "K1" })]]));
    await builder.buildAll({ test: true });
    const { expectAccessibleStructure } = await import("../test/structure");
    for (const [path, content] of storage.files) {
      if (path.endsWith(".html")) {
        expectAccessibleStructure(String(content));
        expect(String(content), path).toContain('<meta name="robots" content="noindex, nofollow">');
      }
    }
  });
});

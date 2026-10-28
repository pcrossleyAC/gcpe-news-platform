import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { TestDatabase } from "@gcpe/db-kit";
import { createPublicSiteTestDb } from "../test/helpers";
import { fakeNewsApi } from "../test/fake-news-api";
import { memoryStorage } from "../test/memory-storage";
import { bcSettings, post, site } from "../test/fixtures";
import { createSiteBuilder } from "./builder";
import type { GovernmentTermDto, GovernmentTermsDto, PostDto } from "./dto";
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
    for (const f of ["releases/K1/index.html", "releases/S1/index.html", "index.html", "ministries/index.html", "ministries/health/index.html", "ministries/finance/index.html", "archive/index.html", "search/index.html", "sitemap.xml", "sitemaps/pages.xml", "assets/theme.css", "assets/site-banner.json", "connect/index.html", "robots.txt", "404.html"]) {
      expect(storage.files.has(f), f).toBe(true);
    }
    expect(html(storage, "sitemaps/pages.xml")).toContain("/search/");
    expect(html(storage, "sitemaps/pages.xml")).toContain("https://news.example/connect/");
  });

  it("legacy-redirects writes legacy/ministry-successors.json from the News API, and is an aggregate page", async () => {
    const { storage, api, builder } = setup(new Map());
    api.successors = { b: "c", a: "c" };
    expect(await builder.renderPage("legacy-redirects", {})).toEqual([]);
    expect(JSON.parse(html(storage, "legacy/ministry-successors.json"))).toEqual({ successors: { a: "c", b: "c" } });
    // A reactivation (N12) empties the map: the file is rewritten, not left stale.
    api.successors = {};
    await builder.renderPage("legacy-redirects", {});
    expect(JSON.parse(html(storage, "legacy/ministry-successors.json"))).toEqual({ successors: {} });
    expect(await builder.aggregatePageIds()).toContain("legacy-redirects");
  });

  it("ministryPageIds: every ministry page, nothing else", async () => {
    const { builder } = setup(new Map([["K1", post({ key: "K1" })]]));
    expect(await builder.ministryPageIds()).toEqual(["category:ministries:finance", "category:ministries:health"]);
  });

  // New-government spec §5: a published cabinet change emits one org event per ministry it touches,
  // and each queues the ministries index plus that ministry's page. One drain rebuilds /ministries/ once.
  it("25 org changes in one drain render ministries once", async () => {
    const { storage, builder } = setup(new Map());
    const render = vi.spyOn(builder, "renderPage");
    const ids = Array.from({ length: 25 }, (_, i) => [`category:ministries:ministry-${i}`, "ministries"]).flat();
    await builder.rebuild(ids, {});
    expect(render.mock.calls.filter(([id]) => id === "ministries")).toHaveLength(1);
    expect(render.mock.calls.filter(([id]) => id.startsWith("category:ministries:"))).toHaveLength(25);
    expect(storage.files.has("ministries/index.html")).toBe(true);
  });

  it("the connect page renders the settings it's given", async () => {
    const { storage, builder } = setup(new Map());
    const settings = bcSettings();
    settings.connect.blogs.featured = [{ text: "The Newest Blog", url: "https://news.example/blog" }];
    await builder.renderPage("connect", { settings });
    expect(html(storage, "connect/index.html")).toContain("The Newest Blog");
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

  describe("archive by government term", () => {
    const LEGACY = "https://archive.news.gov.bc.ca/releases";
    const t = (slug: string, startDate: string, endDate: string | null, legacyArchiveUrl: string | null = null): GovernmentTermDto => ({ slug, label: null, startDate, endDate, legacyArchiveUrl });
    const snapshot = (...terms: GovernmentTermDto[]): GovernmentTermsDto => ({ publishedAt: "2028-11-20T07:00:00.000Z", currentSlug: terms[0]!.slug, terms });
    const hrefs = (s: ReturnType<typeof memoryStorage>, path: string) => [...html(s, path).matchAll(/<main[\s\S]*<\/main>/g)].flatMap((m) => [...m[0].matchAll(/href="([^"]+)"/g)].map((x) => x[1]!));

    it("places boundary posts by BC day", async () => {
      const posts = new Map([
        ["EVE", post({ key: "EVE", publishDate: "2028-11-19T23:59:00-08:00" })],
        ["DAY", post({ key: "DAY", publishDate: "2028-11-20T00:00:00-08:00" })],
      ]);
      const { storage, api, builder } = setup(posts);
      api.terms = snapshot(t("2028-11-20", "2028-11-20", null), t("2024-2028", "2024-11-18", "2028-11-19"));
      await builder.rebuild(["post:EVE", "post:DAY"], {});
      const old = html(storage, "archive/terms/2024-2028/index.html");
      const now = html(storage, "archive/terms/2028-11-20/index.html");
      expect(old).toContain("/releases/EVE/");
      expect(old).not.toContain("/releases/DAY/");
      expect(now).toContain("/releases/DAY/");
      expect(now).not.toContain("/releases/EVE/");
      expect(html(storage, "archive/terms/current/index.html")).toContain("/releases/DAY/");
      expect(html(storage, "archive/terms/index.html")).toContain("(1 post)");
    });

    it("a short term lists only its weeks", async () => {
      const posts = new Map([
        ["IN", post({ key: "IN", publishDate: "2017-07-17T16:00:00-07:00" })],
        ["OUT", post({ key: "OUT", publishDate: "2017-07-18T09:00:00-07:00" })],
        ["BEFORE", post({ key: "BEFORE", publishDate: "2017-06-11T09:00:00-07:00" })],
      ]);
      const { storage, api, builder } = setup(posts);
      api.terms = snapshot(t("2017-2021", "2017-07-18", null), t("2017-2017", "2017-06-12", "2017-07-17"), t("2013-2017", "2013-06-10", "2017-06-11"));
      await builder.rebuild(["post:IN", "post:OUT", "post:BEFORE"], {});
      const page = html(storage, "archive/terms/2017-2017/index.html");
      expect(page).toContain("June 12, 2017 to July 17, 2017");
      expect(page).toContain("/releases/IN/");
      expect(page).not.toContain("/releases/OUT/");
      expect(page).not.toContain("/releases/BEFORE/");
    });

    it("empty current term renders the empty copy and the current alias canonicalises to the slug", async () => {
      const { storage, api, builder } = setup(new Map([["K1", post({ key: "K1", publishDate: "2026-10-03T10:00:00-07:00" })]]));
      api.terms = snapshot(t("2028-11-20", "2028-11-20", null), t("2024-2028", "2024-11-18", "2028-11-19"));
      await builder.buildAll({});
      for (const f of ["archive/terms/2028-11-20/index.html", "archive/terms/current/index.html"]) {
        expect(html(storage, f), f).toContain("Nothing has been published in this term yet.");
        expect(html(storage, f)).toContain("<h1>News from November 20, 2028 to current date</h1>");
        expect(/<link rel="canonical" href="([^"]+)"/.exec(html(storage, f))![1]).toMatch(/\/archive\/terms\/2028-11-20\/$/);
      }
      expect(html(storage, "archive/terms/2024-2028/index.html")).toContain("/releases/K1/");
    });

    it("adding a term links it from the index with no other change", async () => {
      const { storage, api, builder } = setup(new Map([["K1", post({ key: "K1" })]]));
      api.terms = snapshot(t("2024-2028", "2024-11-18", null), t("2020-2024", "2020-11-26", "2024-11-17"));
      await builder.buildAll({});
      const before = hrefs(storage, "archive/terms/index.html");
      api.terms = snapshot(t("2028-11-20", "2028-11-20", null), t("2024-2028", "2024-11-18", "2028-11-19"), t("2020-2024", "2020-11-26", "2024-11-17"));
      await builder.rebuild(await builder.termPageIds(), {});
      const after = hrefs(storage, "archive/terms/index.html");
      expect(after.filter((h) => !before.includes(h))).toEqual(["/archive/terms/2028-11-20/"]);
      expect(before.filter((h) => !after.includes(h))).toEqual([]);
      expect(storage.files.has("archive/terms/2028-11-20/index.html")).toBe(true);
      // The crawler path: entry point → term page → every post in range.
      expect(html(storage, "archive/terms/2024-2028/index.html")).toContain("/releases/K1/");
    });

    it("legacy-only terms link out and get no page", async () => {
      const { storage, api, builder } = setup(new Map([["K1", post({ key: "K1" })]]));
      api.terms = snapshot(t("2024-2028", "2024-11-18", null, `${LEGACY}/index_current.htm`), t("pre2001", "1994-01-01", "2001-06-04", `${LEGACY}/index_pre2001.htm`));
      await storage.write("archive/terms/pre2001/index.html", "stale");
      await builder.buildAll({});
      expect(hrefs(storage, "archive/terms/index.html")).toContain(`${LEGACY}/index_pre2001.htm`);
      expect(hrefs(storage, "archive/terms/index.html")).not.toContain("/archive/terms/pre2001/");
      expect(storage.files.has("archive/terms/pre2001/index.html")).toBe(false);
      expect(html(storage, "sitemaps/pages.xml")).not.toContain("/archive/terms/pre2001/");
    });

    it("sitemap pages list /archive/terms/ and each term page", async () => {
      const { storage, api, builder } = setup(new Map([["K1", post({ key: "K1" })]]));
      api.terms = snapshot(t("2028-11-20", "2028-11-20", null), t("2024-2028", "2024-11-18", "2028-11-19"));
      await builder.buildAll({});
      const xml = html(storage, "sitemaps/pages.xml");
      for (const path of ["/archive/terms/", "/archive/terms/2028-11-20/", "/archive/terms/2024-2028/"]) expect(xml).toContain(`<loc>https://news.example${path}</loc>`);
      expect(xml).not.toContain("/archive/terms/current/");
    });

    it("a post change queues its term page, the current alias and the index", async () => {
      const { api, builder } = setup(new Map([["K1", post({ key: "K1", publishDate: "2024-12-01T10:00:00-08:00" })]]));
      api.terms = snapshot(t("2024-11-18", "2024-11-18", null), t("2020-2024", "2020-11-26", "2024-11-17"));
      expect(await builder.renderPage("post:K1", {})).toEqual(expect.arrayContaining(["archive-term:2024-11-18", "archive-term:current", "archive-terms"]));
    });

    it("no terms published yet: the index says so and no term page is written", async () => {
      const { storage, builder } = setup(new Map([["K1", post({ key: "K1" })]]));
      await builder.buildAll({});
      expect(html(storage, "archive/terms/index.html")).toContain("No government terms have been published yet.");
      expect([...storage.files.keys()].filter((f) => f.startsWith("archive/terms/") && f !== "archive/terms/index.html")).toEqual([]);
      expect(await builder.termPageIds()).toEqual(["archive-terms", "archive-term:current"]);
    });

    it("termPageIds: the index, the alias and every public term", async () => {
      const { api, builder } = setup(new Map());
      api.terms = snapshot(t("2024-2028", "2024-11-18", null), t("pre2001", "1994-01-01", "2001-06-04", `${LEGACY}/x.htm`));
      expect(await builder.termPageIds()).toEqual(["archive-terms", "archive-term:current", "archive-term:2024-2028", "archive-term:pre2001"]);
    });
  });
});

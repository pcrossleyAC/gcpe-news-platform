import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { TestDatabase } from "@gcpe/db-kit";
import { createPublicSiteTestDb } from "../test/helpers";
import { fakeNewsApi } from "../test/fake-news-api";
import { memoryStorage } from "../test/memory-storage";
import { bcSettings, post, site } from "../test/fixtures";
import { createSiteBuilder, SECTOR_FETCHES } from "./builder";
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

  it("home: News by Sector lists the active sectors by name, each with its latest post; a sector with none is left out", async () => {
    const posts = new Map([
      ["K1", post({ key: "K1", sectorKeys: ["economy"], documents: [{ languageId: 4105, headline: "Economy headline", subheadline: null, detailsHtml: null, contacts: [] }] })],
      ["K2", post({ key: "K2", sectorKeys: ["agriculture", "retired"], publishDate: "2026-10-04T10:00:00-07:00", documents: [{ languageId: 4105, headline: "Farm headline", subheadline: null, detailsHtml: null, contacts: [] }] })],
    ]);
    const { storage, api, builder } = setup(posts);
    const sector = (key: string, name: string, isActive = true) => ({ key, kind: "sectors", name, isActive, topPostKey: null, featurePostKey: null });
    api.sectors = [sector("economy", "Economy"), sector("retired", "Retired sector", false), sector("agriculture", "Agriculture"), sector("empty", "Empty")];
    await builder.rebuild(["home"], { settings: bcSettings() });
    const page = html(storage, "index.html");
    const box = page.slice(page.indexOf("News by Sector"));
    expect(box.indexOf("Agriculture")).toBeGreaterThan(0);
    expect(box.indexOf("Agriculture")).toBeLessThan(box.indexOf("Economy"));
    expect(box).toContain('<a href="/releases/K2/">Farm headline</a>');
    expect(box).toContain('<a href="/releases/K1/">Economy headline</a>');
    expect(page).not.toContain("Retired sector");
    expect(page).not.toContain(">Empty<");
  });

  it("home: a sector whose latest fetch fails is left out (logged) and the page still renders; fetches run at most SECTOR_FETCHES at once", async () => {
    const posts = new Map([["K1", post({ key: "K1", sectorKeys: ["economy", "broken"], documents: [{ languageId: 4105, headline: "Economy headline", subheadline: null, detailsHtml: null, contacts: [] }] })]]);
    const { storage, api, builder } = setup(posts);
    const sector = (key: string, name: string) => ({ key, kind: "sectors", name, isActive: true, topPostKey: null, featurePostKey: null });
    api.sectors = [sector("economy", "Economy"), sector("broken", "Broken"), ...Array.from({ length: 12 }, (_, i) => sector(`s${i}`, `Sector ${i}`))];
    const latest = api.latest;
    let inFlight = 0;
    let peak = 0;
    api.latest = async (kind, key, n) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      if (key === "broken") throw new Error("News API 500");
      return latest(kind, key, n);
    };
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    await builder.rebuild(["home"], {});
    const page = html(storage, "index.html");
    expect(page).toContain("News by Sector");
    expect(page).toContain('<a href="/releases/K1/">Economy headline</a>');
    expect(page).not.toContain(">Broken<");
    expect(error.mock.calls.flat().join(" ")).toContain("sector:broken");
    expect(peak).toBeLessThanOrEqual(SECTOR_FETCHES);
    expect(peak).toBeGreaterThan(1);

    // The sector list itself failing: the box is left out, home still renders.
    api.categories = async () => { throw new Error("News API down"); };
    await builder.rebuild(["home"], {});
    expect(html(storage, "index.html")).not.toContain("News by Sector");
    expect(html(storage, "index.html")).toContain("Latest news");
    error.mockRestore();
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

  it("writes ministries/<key>/biography/index.html when the minister has details; clearing details removes the file on the next render", async () => {
    const { storage, api, builder } = setup(new Map());
    const minister = { headline: "Hon. Alex Example", summary: "Minister of Health.", details: "<p>Alex was elected in 2020.</p>", photo: null };
    api.minister = async (key) => (key.toLowerCase() === "health" ? minister : null);
    api.ministryProfiles = async () => [{ key: "Health", ministerEmail: "hlth@gov.example", teamLinks: [], childKeys: [] }];
    await builder.renderPage("category:ministries:health", {});
    const bio = html(storage, "ministries/health/biography/index.html");
    expect(bio).toContain("<h1>Hon. Alex Example</h1>");
    expect(bio).toContain("Alex was elected in 2020.");
    expect(bio).toContain('href="mailto:hlth@gov.example"');
    // Cleared in the Hub: the stale bio page goes on the next render, the ministry page stays.
    minister.details = null as unknown as string;
    await builder.renderPage("category:ministries:health", {});
    expect(storage.files.has("ministries/health/biography/index.html")).toBe(false);
    expect(storage.files.has("ministries/health/index.html")).toBe(true);
    // A ministry with no minister never gets one; a vanished ministry loses all three files.
    await builder.renderPage("category:ministries:finance", {});
    expect(storage.files.has("ministries/finance/biography/index.html")).toBe(false);
    await storage.write("ministries/gone/biography/index.html", "x");
    await builder.renderPage("category:ministries:gone", {});
    expect(storage.files.has("ministries/gone/biography/index.html")).toBe(false);
  });

  it("profile fetch failure: renders the pages without the Contact email (profiles(run) failure is logged, not thrown)", async () => {
    const { storage, api, builder } = setup(new Map());
    api.minister = async () => ({ headline: "Hon. Alex Example", summary: null, details: "Bio text", photo: null });
    api.ministryProfiles = async () => { throw Object.assign(new Error("secret detail"), { code: "ECONNREFUSED" }); };
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await builder.rebuild(["category:ministries:health", "category:ministries:finance"], {});
      expect(storage.files.has("ministries/health/index.html")).toBe(true);
      const bio = html(storage, "ministries/health/biography/index.html");
      expect(bio).toContain("<h1>Hon. Alex Example</h1>");
      expect(bio).not.toContain("minister-email");
      expect(bio).not.toContain("mailto:");
      // Logged once for the run (the result is memoised), with the error's safe label.
      const logged = error.mock.calls.map((c) => String(c[0])).filter((m) => m.includes("ministry profiles"));
      expect(logged).toHaveLength(1);
      expect(logged[0]).toContain("ECONNREFUSED");
      expect(logged[0]).not.toContain("secret detail");
    } finally {
      error.mockRestore();
    }
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

  it("the release page's lead ministry is found case-insensitively by leadMinistryKey, else the first ministryKey", async () => {
    const { storage, builder } = setup(new Map([["K1", post({ key: "K1", leadMinistryKey: "HEALTH", ministryKeys: ["finance"] })], ["K2", post({ key: "K2", leadMinistryKey: null, ministryKeys: ["Finance"] })], ["K3", post({ key: "K3", leadMinistryKey: "nope" })]]));
    await builder.rebuild(["post:K1", "post:K2", "post:K3"], {});
    expect(html(storage, "releases/K1/index.html")).toContain('<p class="story-ministry"><a href="/ministries/health/">Health</a></p>');
    expect(html(storage, "releases/K1/index.html")).toContain("More from this Ministry");
    expect(html(storage, "releases/K2/index.html")).toContain('<p class="story-ministry"><a href="/ministries/finance/">Finance</a></p>');
    expect(html(storage, "releases/K3/index.html")).not.toContain("story-ministry");
  });

  it("a related-posts failure doesn't block the release page", async () => {
    const { storage, api, builder } = setup(new Map([["K1", post({ key: "K1" })]]));
    api.related = async () => { throw new Error("News API 500"); };
    await builder.rebuild(["post:K1"], {});
    expect(storage.files.has("releases/K1/index.html")).toBe(true);
  });

  it("fetches the ministry's latest once per run and only when related is empty; a failure renders the page without a fallback", async () => {
    const posts = new Map([
      ["K1", post({ key: "K1", leadMinistryKey: "Health", ministryKeys: ["health"], publishDate: "2026-10-01T10:00:00-07:00", documents: [{ languageId: 4105, headline: "One", subheadline: null, detailsHtml: null, contacts: [] }] })],
      ["K2", post({ key: "K2", ministryKeys: ["health"], publishDate: "2026-10-02T10:00:00-07:00", documents: [{ languageId: 4105, headline: "Two", subheadline: null, detailsHtml: null, contacts: [] }] })],
      ["K3", post({ key: "K3", ministryKeys: ["finance"], publishDate: "2026-10-03T10:00:00-07:00" })],
    ]);
    const { storage, api, builder } = setup(posts);
    const latest = vi.spyOn(api, "latest");
    const relatedTo = new Map([["K3", [{ key: "K9", headline: "Nine", publishDate: "2026-09-09T09:00:00-07:00" }]]]);
    api.related = async (key) => relatedTo.get(key) ?? [];
    // One run (as rebuild and buildAll share one) rendering the three post pages.
    const run = {};
    for (const k of ["K1", "K2", "K3"]) await builder.renderPage(`post:${k}`, {}, run);
    // K1 and K2 share health's fetch; K3 has v2 related, so finance's latest is never asked for.
    expect(latest.mock.calls).toEqual([["ministries", "health", 4]]);
    const band = (k: string) => html(storage, `releases/${k}/index.html`).split('<section class="media-container"')[1] ?? "";
    expect(band("K1")).toContain(">Two</a>");
    expect(band("K1")).not.toContain(">One</a>");
    expect(band("K2")).toContain(">One</a>");
    expect(band("K2")).not.toContain(">Two</a>");
    expect(band("K3")).toContain(">Nine</a>");

    // A failure: logged without the error's text, and the page renders with no Related Articles.
    const failing = setup(new Map([["K1", post({ key: "K1" })]]));
    failing.api.latest = async () => { throw new Error("News API 500 secret=abc"); };
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    await failing.builder.renderPage("post:K1", {});
    expect(failing.storage.files.has("releases/K1/index.html")).toBe(true);
    expect(html(failing.storage, "releases/K1/index.html")).not.toContain("Related Articles");
    expect(log.mock.calls.some(([line]) => String(line).includes("post:K1"))).toBe(true);
    expect(log.mock.calls.flat().join(" ")).not.toContain("secret=abc");
    log.mockRestore();
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
});

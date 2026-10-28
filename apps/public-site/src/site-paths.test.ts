import { describe, expect, it } from "vitest";
import { absoluteUrl, biographyUrl, categoryPageId, feedUrl, formatPageId, kindFeedFile, pageFiles, pageUrl, parsePageId, POST_KEY, postDir, postPath } from "./site-paths";

const site = { name: "N", baseUrl: "https://boxs.example/site" };

describe("parsePageId", () => {
  it.each([
    ["home", { type: "home" }],
    ["post:2026HLTH0001-000001", { type: "post", key: "2026HLTH0001-000001" }],
    ["ministries", { type: "ministries" }],
    ["category:ministries:health", { type: "category", kind: "ministries", key: "health" }],
    ["category:tags:covid-19", { type: "category", kind: "tags", key: "covid-19" }],
    ["archive", { type: "archive" }],
    ["archive:2026-10", { type: "archive-month", month: "2026-10" }],
    ["search", { type: "search" }],
    ["sitemap", { type: "sitemap" }],
    ["sitemap:2026-01", { type: "sitemap-month", month: "2026-01" }],
    ["sitemap:pages", { type: "sitemap-pages" }],
    ["static", { type: "static" }],
    ["connect", { type: "connect" }],
    ["privacy", { type: "privacy" }],
    ["live", { type: "live" }],
    ["archive-terms", { type: "archive-terms" }],
    ["archive-term:2024-11-18", { type: "archive-term", slug: "2024-11-18" }],
    ["archive-term:2017-2017", { type: "archive-term", slug: "2017-2017" }],
    ["archive-term:pre2001", { type: "archive-term", slug: "pre2001" }],
    ["archive-term:current", { type: "archive-term", slug: "current" }],
  ])("%s", (id, expected) => {
    expect(parsePageId(id)).toEqual(expected);
    expect(formatPageId(parsePageId(id)!)).toBe(id);
  });

  it.each([
    "", "post:", "post:..", "post:a/b", "post:a.b", "post:../etc", `post:${"a".repeat(201)}`, "post:a:b",
    "category:ministries:Health", "category:ministries:../../etc", "category:ministries:a/b", "category:people:x", "category:ministries", "category:ministries:x:y",
    "archive:2026-13", "archive:2026-00", "archive:26-10", "archive:2026-10:x", "sitemap:2026-1", "nope", "home:x",
    "archive-term:../x", "archive-term:", "archive-term:A", "archive-term:a/b", "archive-term:a.b", `archive-term:${"a".repeat(41)}`, "archive-term:a:b", "archive-terms:x",
  ])("refuses %j", (id) => {
    expect(parsePageId(id)).toBeNull();
  });
});

describe("categoryPageId", () => {
  it("lowercases a valid key and refuses an unsafe one", () => {
    expect(categoryPageId("ministries", "Health")).toBe("category:ministries:health");
    expect(categoryPageId("ministries", "56429306-8C3E-4991-AEB2-1CC86F20BFDD")).toBe("category:ministries:56429306-8c3e-4991-aeb2-1cc86f20bfdd");
    expect(categoryPageId("tags", "a b")).toBeNull();
    expect(categoryPageId("tags", "..")).toBeNull();
  });
});

describe("pageFiles", () => {
  it.each([
    ["home", ["index.html", "feed.xml", "atom.xml", "assets/live.json"]],
    ["post:K1", ["releases/K1/index.html"]],
    ["ministries", ["ministries/index.html"]],
    ["category:sectors:economy", ["sectors/economy/index.html", "sectors/economy/feed.xml", "sectors/economy/atom.xml"]],
    ["category:ministries:health", ["ministries/health/index.html", "ministries/health/feed.xml", "ministries/health/atom.xml", "ministries/health/biography/index.html"]],
    ["archive", ["archive/index.html"]],
    ["archive:2026-10", ["archive/2026/10/index.html"]],
    ["search", ["search/index.html"]],
    ["sitemap", ["sitemap.xml"]],
    ["sitemap:2026-10", ["sitemaps/2026-10.xml"]],
    ["sitemap:pages", ["sitemaps/pages.xml"]],
    ["static", ["assets/theme.css", "assets/site-banner.json", "404.html", "robots.txt"]],
    ["connect", ["connect/index.html"]],
    ["privacy", ["privacy/index.html"]],
    ["live", ["live/index.html", "assets/live.json"]],
    ["archive-terms", ["archive/terms/index.html"]],
    ["archive-term:2017-2017", ["archive/terms/2017-2017/index.html"]],
    ["archive-term:current", ["archive/terms/current/index.html"]],
    ["legacy-redirects", ["legacy/ministry-successors.json"]],
  ])("%s", (id, files) => {
    expect(pageFiles(parsePageId(id)!)).toEqual(files);
  });
});

describe("contacts (H3)", () => {
  it("parsePageId('contacts') round-trips; pageFiles is contacts/index.html", () => {
    const p = parsePageId("contacts")!;
    expect(p).toEqual({ type: "contacts" });
    expect(formatPageId(p)).toBe("contacts");
    expect(pageFiles(p)).toEqual(["contacts/index.html"]);
    expect(pageUrl(site, p)).toBe("/site/contacts/");
  });
});

describe("pageFiles: the biography page (H2)", () => {
  it("a ministries category page owns index.html, feed.xml and biography/index.html; a sector page still owns two files", () => {
    expect(pageFiles({ type: "category", kind: "ministries", key: "health" })).toEqual(["ministries/health/index.html", "ministries/health/feed.xml", "ministries/health/atom.xml", "ministries/health/biography/index.html"]);
    expect(pageFiles({ type: "category", kind: "sectors", key: "economy" })).toHaveLength(3);
    expect(biographyUrl(site, "Citizens-Services")).toBe("/site/ministries/citizens-services/biography/");
    expect(biographyUrl({ baseUrl: "https://news.example" }, "health")).toBe("/ministries/health/biography/");
  });
});

describe("kind feeds", () => {
  it("pageFiles(kind-feeds) is the eight feeds/* files; parsePageId('kind-feeds') round-trips", () => {
    const p = parsePageId("kind-feeds")!;
    expect(formatPageId(p)).toBe("kind-feeds");
    expect(pageFiles(p)).toEqual([
      "feeds/releases.xml", "feeds/releases.atom.xml", "feeds/stories.xml", "feeds/stories.atom.xml",
      "feeds/factsheets.xml", "feeds/factsheets.atom.xml", "feeds/updates.xml", "feeds/updates.atom.xml",
    ]);
    expect(kindFeedFile("stories", "atom")).toBe("feeds/stories.atom.xml");
  });
});

describe("urls", () => {
  it("carry the base path and a trailing slash for directory pages", () => {
    expect(pageUrl(site, { type: "home" })).toBe("/site/");
    expect(pageUrl(site, { type: "post", key: "K1" })).toBe("/site/releases/K1/");
    expect(pageUrl(site, { type: "category", kind: "themes", key: "health" })).toBe("/site/themes/health/");
    expect(pageUrl(site, { type: "archive-month", month: "2026-10" })).toBe("/site/archive/2026/10/");
    expect(pageUrl(site, { type: "search" })).toBe("/site/search/");
    expect(pageUrl(site, { type: "connect" })).toBe("/site/connect/");
    expect(pageUrl(site, { type: "live" })).toBe("/site/live/");
    expect(pageUrl(site, { type: "archive-terms" })).toBe("/site/archive/terms/");
    expect(pageUrl(site, { type: "archive-term", slug: "2028-11-20" })).toBe("/site/archive/terms/2028-11-20/");
    expect(pageUrl(site, { type: "legacy-redirects" })).toBe("/site/legacy/ministry-successors.json");
    expect(feedUrl(site, { type: "home" })).toBe("/site/feed.xml");
    expect(feedUrl(site, { type: "category", kind: "tags", key: "covid-19" })).toBe("/site/tags/covid-19/feed.xml");
    expect(absoluteUrl(site, "/site/x/")).toBe("https://boxs.example/site/x/");
  });
});

describe("long post keys (url-compat T3, M17)", () => {
  const M17 = "canada-and-british-columbia-investments-in-local-infrastructure-help-build-community-connections-for-1";
  it("postPath of the 102-char M17 key is releases/_long/106422386aca9cfd948a818d5a9a92f5/index.html", () => {
    expect(M17).toHaveLength(102);
    expect(postPath(M17)).toBe("releases/_long/106422386aca9cfd948a818d5a9a92f5/index.html");
    expect(postDir(M17.toUpperCase())).toBe("releases/_long/106422386aca9cfd948a818d5a9a92f5");
  });
  it("a 100-char key keeps releases/<key>/index.html", () => {
    const k = "a".repeat(100);
    expect(postPath(k)).toBe(`releases/${k}/index.html`);
    expect(postDir("K1")).toBe("releases/K1");
  });
  it("POST_KEY accepts 200 chars, rejects 201, '../x', 'a/b' and '_long'", () => {
    expect(POST_KEY.test("a".repeat(200))).toBe(true);
    for (const bad of ["a".repeat(201), "../x", "a/b", "_long", ""]) expect(POST_KEY.test(bad), bad).toBe(false);
  });
  it("pageUrl of the long key is /releases/<key>/", () => {
    expect(pageUrl(site, { type: "post", key: M17 })).toBe(`/site/releases/${M17}/`);
  });
  it("a long key's files are the page and its .key sidecar; a short key's only the page", () => {
    expect(pageFiles({ type: "post", key: M17 })).toEqual([postPath(M17), "releases/_long/106422386aca9cfd948a818d5a9a92f5/.key"]);
    expect(pageFiles({ type: "post", key: "K1" })).toEqual(["releases/K1/index.html"]);
  });
});

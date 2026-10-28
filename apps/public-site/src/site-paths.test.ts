import { describe, expect, it } from "vitest";
import { absoluteUrl, categoryPageId, feedUrl, formatPageId, pageFiles, pageUrl, parsePageId } from "./site-paths";

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
  ])("%s", (id, expected) => {
    expect(parsePageId(id)).toEqual(expected);
    expect(formatPageId(parsePageId(id)!)).toBe(id);
  });

  it.each([
    "", "post:", "post:..", "post:a/b", "post:a.b", "post:../etc", `post:${"a".repeat(101)}`, "post:a:b",
    "category:ministries:Health", "category:ministries:../../etc", "category:ministries:a/b", "category:people:x", "category:ministries", "category:ministries:x:y",
    "archive:2026-13", "archive:2026-00", "archive:26-10", "archive:2026-10:x", "sitemap:2026-1", "nope", "home:x",
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
    ["home", ["index.html", "feed.xml"]],
    ["post:K1", ["releases/K1/index.html"]],
    ["ministries", ["ministries/index.html"]],
    ["category:sectors:economy", ["sectors/economy/index.html", "sectors/economy/feed.xml"]],
    ["archive", ["archive/index.html"]],
    ["archive:2026-10", ["archive/2026/10/index.html"]],
    ["search", ["search/index.html"]],
    ["sitemap", ["sitemap.xml"]],
    ["sitemap:2026-10", ["sitemaps/2026-10.xml"]],
    ["sitemap:pages", ["sitemaps/pages.xml"]],
    ["static", ["assets/theme.css", "assets/site-banner.json", "404.html", "robots.txt"]],
    ["connect", ["connect/index.html"]],
  ])("%s", (id, files) => {
    expect(pageFiles(parsePageId(id)!)).toEqual(files);
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
    expect(feedUrl(site, { type: "home" })).toBe("/site/feed.xml");
    expect(feedUrl(site, { type: "category", kind: "tags", key: "covid-19" })).toBe("/site/tags/covid-19/feed.xml");
    expect(absoluteUrl(site, "/site/x/")).toBe("https://boxs.example/site/x/");
  });
});

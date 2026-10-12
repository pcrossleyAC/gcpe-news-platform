import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import { site } from "../test/fixtures";
import { renderSitemapIndex, renderUrlSet } from "./sitemaps";

const NS = "http://www.sitemaps.org/schemas/sitemap/0.9";

describe("sitemap index", () => {
  it("is a sitemapindex with absolute locs, in the sitemaps.org namespace", () => {
    const xml = renderSitemapIndex(["/sitemaps/pages.xml", "/sitemaps/2026-10.xml"], site);
    const doc = new JSDOM(xml, { contentType: "application/xml" }).window.document;
    expect(doc.querySelector("parsererror")).toBeNull();
    expect(doc.documentElement.localName).toBe("sitemapindex");
    expect(doc.documentElement.namespaceURI).toBe(NS);
    expect([...doc.querySelectorAll("sitemap > loc")].map((l) => l.textContent)).toEqual(["https://news.example/sitemaps/pages.xml", "https://news.example/sitemaps/2026-10.xml"]);
  });
});

describe("URL set", () => {
  const xml = renderUrlSet([{ path: "/releases/K1/", lastmod: "2026-10-03T10:00:00-07:00" }, { path: "/a&b/" }], site);

  it("has an absolute escaped loc and a date-only W3C lastmod, with no lastmod on the second entry", () => {
    expect(xml).toContain("https://news.example/a&amp;b/");
    const doc = new JSDOM(xml, { contentType: "application/xml" }).window.document;
    expect(doc.querySelector("parsererror")).toBeNull();
    expect(doc.documentElement.localName).toBe("urlset");
    expect(doc.documentElement.namespaceURI).toBe(NS);
    const urls = [...doc.querySelectorAll("url")];
    expect(urls[0]?.querySelector("loc")?.textContent).toBe("https://news.example/releases/K1/");
    expect(urls[0]?.querySelector("lastmod")?.textContent).toBe("2026-10-03");
    expect(urls[1]?.querySelector("loc")?.textContent).toBe("https://news.example/a&b/");
    expect(urls[1]?.querySelector("lastmod")).toBeNull();
  });

  it("strips XML-illegal control characters from a loc, staying well-formed", () => {
    const hostile = renderUrlSet([{ path: "/a\u0007b/" }], site);
    expect(hostile).not.toMatch(/\u0007/);
    expect(new JSDOM(hostile, { contentType: "application/xml" }).window.document.querySelector("parsererror")).toBeNull();
  });
});

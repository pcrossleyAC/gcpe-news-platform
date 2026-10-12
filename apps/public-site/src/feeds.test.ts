import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import { post, site } from "../test/fixtures";
import { renderRssFeed } from "./feeds";

describe("RSS 2.0 feeds", () => {
  const xml = renderRssFeed({ title: "Health & <news>", pagePath: "/ministries/health/", feedPath: "/ministries/health/feed.xml", description: "Latest" }, [
    post({ key: "K1", summary: "S & <b>", documents: [{ languageId: 4105, headline: "Clinics <open>", subheadline: null, detailsHtml: null, contacts: [] }] }),
  ], site);

  it("is well-formed RSS 2.0 with absolute links and RFC 822 dates", () => {
    const doc = new JSDOM(xml, { contentType: "application/xml" }).window.document;
    expect(doc.querySelector("parsererror")).toBeNull();
    expect(doc.documentElement.getAttribute("version")).toBe("2.0");
    expect(doc.querySelector("channel > title")?.textContent).toBe("Health & <news>");
    expect(doc.querySelector("channel > link")?.textContent).toBe("https://news.example/ministries/health/");
    const item = doc.querySelector("item")!;
    expect(item.querySelector("title")?.textContent).toBe("Clinics <open>");
    expect(item.querySelector("link")?.textContent).toBe("https://news.example/releases/K1/");
    expect(item.querySelector("guid")?.getAttribute("isPermaLink")).toBe("true");
    expect(item.querySelector("pubDate")?.textContent).toBe("Sat, 03 Oct 2026 17:00:00 GMT");
    expect(item.querySelector("description")?.textContent).toBe("S & <b>");
  });
  it("escapes feed and sitemap text: no raw markup in the XML", () => {
    expect(xml).not.toContain("<open>");
    expect(xml).not.toContain("<b>");
  });
  it("caps at 20 items", () => {
    const many = Array.from({ length: 25 }, (_, i) => post({ key: `K${i}` }));
    expect(renderRssFeed({ title: "t", pagePath: "/", feedPath: "/feed.xml", description: "d" }, many, site).match(/<item>/g)).toHaveLength(20);
  });
  it("strips XML-illegal control characters and keeps ]]> and & from breaking the document", () => {
    const hostile = post({
      key: "K-hostile",
      summary: "S\u0007 end ]]> & <tag>",
      documents: [{ languageId: 4105, headline: "H\u0007 ]]> & <tag>", subheadline: null, detailsHtml: null, contacts: [] }],
    });
    const out = renderRssFeed({ title: "t", pagePath: "/", feedPath: "/feed.xml", description: "d" }, [hostile], site);
    expect(out).not.toMatch(/\u0007/);
    const doc = new JSDOM(out, { contentType: "application/xml" }).window.document;
    expect(doc.querySelector("parsererror")).toBeNull();
    expect(doc.querySelector("item title")?.textContent).toBe("H ]]> & <tag>");
    expect(doc.querySelector("item description")?.textContent).toBe("S end ]]> & <tag>");
  });
});

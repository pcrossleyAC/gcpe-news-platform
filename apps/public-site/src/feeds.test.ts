import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import { post, site } from "../test/fixtures";
import { renderAtomFeed, renderRssFeed } from "./feeds";

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

describe("Atom 1.0 feeds", () => {
  const sub = { ...site, baseUrl: "https://news.example/site" };
  const parse = (x: string) => new JSDOM(x, { contentType: "application/xml" }).window.document;
  const ch = { title: "Health", pagePath: "/site/ministries/health/", feedPath: "/site/ministries/health/atom.xml", description: "d" };

  it("Atom: one entry per post, ids and links absolute under a /site base, updated = newest instant in UTC", () => {
    const doc = parse(renderAtomFeed(ch, [
      post({ key: "K1", publishDate: "2026-10-03T10:00:00-07:00" }),
      post({ key: "K2", publishDate: "2026-10-05T09:30:15-07:00", summary: null }),
    ], sub));
    expect(doc.querySelector("parsererror")).toBeNull();
    expect(doc.documentElement.namespaceURI).toBe("http://www.w3.org/2005/Atom");
    const entries = [...doc.querySelectorAll("feed > entry")];
    expect(entries).toHaveLength(2);
    expect(entries[0]!.querySelector("id")?.textContent).toBe("https://news.example/site/releases/K1/");
    expect(entries[0]!.querySelector("link")?.getAttribute("href")).toBe("https://news.example/site/releases/K1/");
    expect(entries[0]!.querySelector("updated")?.textContent).toBe("2026-10-03T17:00:00Z");
    expect(entries[0]!.querySelector("summary")).not.toBeNull();
    expect(entries[1]!.querySelector("summary")).toBeNull();
    expect(doc.querySelector("feed > id")?.textContent).toBe("https://news.example/site/ministries/health/atom.xml");
    expect(doc.querySelector("feed > updated")?.textContent).toBe("2026-10-05T16:30:15Z");
    expect(doc.querySelector('feed > link[rel="self"]')?.getAttribute("type")).toBe("application/atom+xml");
    expect(doc.querySelector('feed > link[rel="alternate"]')?.getAttribute("href")).toBe("https://news.example/site/ministries/health/");
  });

  it("Atom: a headline with & < \" and a U+0001 control char stays well-formed XML", () => {
    const hostile = post({ key: "K-h", summary: "S\u0001 & <b>", documents: [{ languageId: 4105, headline: 'H\u0001 & < "q"', subheadline: null, detailsHtml: null, contacts: [] }] });
    const out = renderAtomFeed({ ...ch, title: 'T & <"' }, [hostile], sub);
    expect(out).not.toMatch(/\u0001/);
    const doc = parse(out);
    expect(doc.querySelector("parsererror")).toBeNull();
    expect(doc.querySelector("entry > title")?.textContent).toBe('H & < "q"');
  });

  it("Atom with no posts has updated 1970-01-01T00:00:00Z and an author", () => {
    const doc = parse(renderAtomFeed(ch, [], sub));
    expect(doc.querySelector("parsererror")).toBeNull();
    expect(doc.querySelector("feed > updated")?.textContent).toBe("1970-01-01T00:00:00Z");
    expect(doc.querySelector("feed > author > name")?.textContent).toBe("BC Gov News");
  });

  it("caps at 20 entries", () => {
    const many = Array.from({ length: 25 }, (_, i) => post({ key: `K${i}` }));
    expect(renderAtomFeed(ch, many, sub).match(/<entry>/g)).toHaveLength(20);
  });
});

describe("legacy item identity: atomId ids and the lead ministry as category (news.gov parity)", () => {
  const ch = { title: "t", pagePath: "/", feedPath: "/feed.xml", description: "d" };
  const names = [{ key: "health", name: "Health & Wellness" }];
  const parse = (x: string) => new JSDOM(x, { contentType: "application/xml" }).window.document;
  const withAtom = post({ key: "K1", leadMinistryKey: "Health", atomId: "uuid:d4727aed-a383-4a45-ad88-b8ebb507ac31" });

  it("RSS: the guid is the post's atomId, not a permalink, so a reader that knew news.gov's items sees no duplicates", () => {
    const item = parse(renderRssFeed(ch, [withAtom], site, names)).querySelector("item")!;
    expect(item.querySelector("guid")?.textContent).toBe("uuid:d4727aed-a383-4a45-ad88-b8ebb507ac31");
    expect(item.querySelector("guid")?.getAttribute("isPermaLink")).toBe("false");
    expect(item.querySelector("category")?.textContent).toBe("Health & Wellness");
  });
  it("RSS: no atomId, or one that isn't a uuid URN, keeps the permalink guid; an unknown ministry adds no category", () => {
    for (const atomId of [undefined, null, "", "javascript:x", "uuid:not-a-uuid"]) {
      const item = parse(renderRssFeed(ch, [post({ key: "K2", leadMinistryKey: "nope", atomId })], site, names)).querySelector("item")!;
      expect(item.querySelector("guid")?.getAttribute("isPermaLink")).toBe("true");
      expect(item.querySelector("guid")?.textContent).toBe("https://news.example/releases/K2/");
      expect(item.querySelector("category")).toBeNull();
    }
  });
  it("Atom: the entry id is the atomId, with the ministry as a category term and a published instant", () => {
    const entry = parse(renderAtomFeed(ch, [withAtom], site, names)).querySelector("entry")!;
    expect(entry.querySelector("id")?.textContent).toBe("uuid:d4727aed-a383-4a45-ad88-b8ebb507ac31");
    expect(entry.querySelector("category")?.getAttribute("term")).toBe("Health & Wellness");
    expect(entry.querySelector("published")?.textContent).toBe("2026-10-03T17:00:00Z");
  });
  it("Atom: without names or an atomId the entry keeps its URL id and has no category", () => {
    const entry = parse(renderAtomFeed(ch, [post({ key: "K3" })], site)).querySelector("entry")!;
    expect(entry.querySelector("id")?.textContent).toBe("https://news.example/releases/K3/");
    expect(entry.querySelector("category")).toBeNull();
  });
});

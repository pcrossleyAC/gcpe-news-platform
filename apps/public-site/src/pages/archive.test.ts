import { describe, expect, it } from "vitest";
import { expectAccessibleStructure } from "../../test/structure";
import { bcSettings, site } from "../../test/fixtures";
import type { GovernmentTermDto } from "../dto";
import type { IndexedPost } from "../post-index";
import { renderArchiveIndex, renderArchiveMonth, renderTermPage, renderTermsIndex, termRangeLabel } from "./archive";

describe("archives", () => {
  it("the index groups months by year, newest first, with counts", () => {
    const doc = expectAccessibleStructure(renderArchiveIndex([{ month: "2026-10", count: 12 }, { month: "2026-09", count: 1 }, { month: "2025-12", count: 3 }], site, {}));
    expect(doc.querySelector("h1")?.textContent).toBe("News archive");
    expect(doc.querySelector("main div.home-body.archive-page > h1")).not.toBeNull();
    expect(doc.querySelectorAll("main .home-body > div.resource-links")).toHaveLength(2);
    expect([...doc.querySelectorAll("h2")].map((h) => h.textContent)).toEqual(["2026", "2025"]);
    expect([...doc.querySelectorAll("main li")].map((li) => li.textContent)).toEqual(["October 2026 (12 posts)", "September 2026 (1 post)", "December 2025 (3 posts)"]);
    expect(doc.querySelector('a[href="/archive/2026/10/"]')).not.toBeNull();
    // one block per year, its own month links inside
    const blocks = [...doc.querySelectorAll("main div.resource-links")];
    expect(blocks.map((b) => b.querySelector("h2")!.textContent)).toEqual(["2026", "2025"]);
    expect(blocks[1]!.querySelectorAll("li")).toHaveLength(1);
  });
  it("an empty index says so", () => {
    expect(expectAccessibleStructure(renderArchiveIndex([], site, {})).querySelector("main p")?.textContent).toBe("Nothing has been published yet.");
  });
  it("month page: one h1, div.article cards with item-date and read-more, no hidden cards", () => {
    const longKey = "k".repeat(120);
    const doc = expectAccessibleStructure(renderArchiveMonth("2026-10", [
      { key: "B", kind: "releases", headline: "B <i>", summary: null, publishDate: "2026-10-05T09:00:00-07:00", month: "2026-10", categories: [] },
      { key: "A", kind: "stories", headline: "A", summary: "S & <b>", publishDate: "2026-10-01T15:30:00-07:00", month: "2026-10", categories: [] },
      { key: longKey, kind: "releases", headline: "Long", summary: null, publishDate: "2026-10-01T09:00:00-07:00", month: "2026-10", categories: [] },
    ], site, {}));
    expect(doc.querySelectorAll("h1")).toHaveLength(1);
    expect(doc.querySelector("h1")?.textContent).toBe("News from October 2026");
    expect(doc.querySelector("main div.home-body#main-content-release.archive-page > h1")).not.toBeNull();
    const cards = [...doc.querySelectorAll("main .other-articles > .regular-articles > div.article")];
    expect(cards).toHaveLength(3);
    expect(doc.querySelector(".hidden-article")).toBeNull();
    expect(doc.querySelector(".load-more")).toBeNull();
    expect(cards.map((c) => c.querySelector("h2 > a")!.textContent)).toEqual(["B <i>", "A", "Long"]);
    expect(cards[0]!.querySelector(".list-container.ps-0.pb-0 > .item-date")!.textContent).toBe("Monday, October 5, 2026 9:00 AM");
    expect(cards[0]!.querySelector("h2 a")!.getAttribute("href")).toBe("/releases/B/");
    expect(cards[0]!.querySelector(".item-text p")).toBeNull();
    expect(cards[1]!.querySelector(".item-content > .item-text > p")!.textContent).toBe("S & <b>");
    expect(cards[1]!.querySelector(".item-date")!.textContent).toBe("Thursday, October 1, 2026 3:30 PM");
    const more = cards[1]!.querySelector(".item-text a.read-more")!;
    expect(more.textContent).toContain("Read More");
    expect(more.querySelector(".visually-hidden")!.textContent).toBe(": A");
    expect(more.getAttribute("href")).toBe("/releases/A/");
    expect(cards[1]!.querySelector(":scope > .clear")).not.toBeNull();
    // a key over 100 characters links to its public URL (/releases/<key>/, the same as postCard);
    // the hashed directory (postDir) is the file layout behind that URL, not the href.
    expect(cards[2]!.querySelector("h2 a")!.getAttribute("href")).toBe(`/releases/${longKey}/`);
    expect(cards[2]!.querySelector("a.read-more")!.getAttribute("href")).toBe(`/releases/${longKey}/`);
    // Scoped to main: the header nav also links to /archive/ ("Archive").
    expect(doc.querySelector('main a[href="/archive/"]')?.textContent).toBe("All months");
  });
  it("an empty month says so", () => {
    expect(expectAccessibleStructure(renderArchiveMonth("2026-10", [], site, {})).querySelector("main p")?.textContent).toBe("Nothing was published this month.");
  });
  it("the index links to the archive by government term", () => {
    const doc = expectAccessibleStructure(renderArchiveIndex([{ month: "2026-10", count: 1 }], site, {}));
    expect(doc.querySelector('main a[href="/archive/terms/"]')?.textContent).toBe("Browse by government term");
  });
});

describe("archive search control", () => {
  const post = (month: string): IndexedPost => ({ key: "A", kind: "releases", headline: "A", summary: null, publishDate: `${month}-02T09:00:00-08:00`, month, categories: [] });
  const control = (html: string) => expectAccessibleStructure(html).querySelector("main .home-body > div.news-control");
  it("a month page ends with Search News filtered to that month, then div.clear", () => {
    const c = control(renderArchiveMonth("2026-10", [post("2026-10")], site, {}))!;
    expect(c.querySelector("a.read-more")!.textContent).toBe("Search News");
    expect(c.querySelector("a.read-more")!.getAttribute("href")).toBe("/search/?from=2026-10-01&to=2026-10-31");
    expect(c.querySelector(":scope > .clear")).not.toBeNull();
  });
  it("month ends: February in a leap and a common year, and a 30-day month", () => {
    const to = (m: string) => control(renderArchiveMonth(m, [post(m)], site, {}))!.querySelector("a")!.getAttribute("href");
    expect(to("2028-02")).toBe("/search/?from=2028-02-01&to=2028-02-29");
    expect(to("2027-02")).toBe("/search/?from=2027-02-01&to=2027-02-28");
    expect(to("2026-04")).toBe("/search/?from=2026-04-01&to=2026-04-30");
    expect(to("2026-12")).toBe("/search/?from=2026-12-01&to=2026-12-31");
  });
  it("a term page links to its range, open or closed; the label is the setting's, escaped", () => {
    const t = { slug: "t", label: null, startDate: "2024-11-18", endDate: null, legacyArchiveUrl: null };
    expect(control(renderTermPage(t, [post("2025-01")], site, {}))!.querySelector("a")!.getAttribute("href")).toBe("/search/?from=2024-11-18");
    expect(control(renderTermPage({ ...t, endDate: "2025-03-01" }, [], site, {}))!.querySelector("a")!.getAttribute("href")).toBe("/search/?from=2024-11-18&to=2025-03-01");
    const settings = bcSettings();
    settings.navigation.labels.searchNews = "Find <news>";
    expect(control(renderArchiveMonth("2026-10", [post("2026-10")], site, { settings }))!.querySelector("a")!.textContent).toBe("Find <news>");
  });
  it("under a base path the link carries it", () => {
    const sub = { ...site, baseUrl: "https://example.test/site" };
    expect(control(renderArchiveMonth("2026-10", [post("2026-10")], sub, {}))!.querySelector("a")!.getAttribute("href")).toBe("/site/search/?from=2026-10-01&to=2026-10-31");
  });
});

describe("archive by government term", () => {
  const LEGACY = "https://archive.news.gov.bc.ca/releases";
  const term = (slug: string, startDate: string, endDate: string | null, over: Partial<GovernmentTermDto> = {}): GovernmentTermDto => ({ slug, label: null, startDate, endDate, legacyArchiveUrl: null, ...over });
  const indexed = (key: string, publishDate: string, headline = key): IndexedPost => ({ key, kind: "releases", headline, summary: "a summary", publishDate, month: publishDate.slice(0, 7), categories: [] });

  it("range labels are generated: open and closed", () => {
    expect(termRangeLabel("2024-11-18", null)).toBe("November 18, 2024 to current date");
    expect(termRangeLabel("2020-11-26", "2024-11-17")).toBe("November 26, 2020 to November 17, 2024");
  });

  it("the index: newest first, range links, label, counts, legacy-only and mixed rows, and the closing line", () => {
    const rows = [
      { term: term("2024-2028", "2024-11-18", null, { label: "Eby <government>", legacyArchiveUrl: `${LEGACY}/index_current.htm` }), count: 12 },
      { term: term("2020-2024", "2020-11-26", "2024-11-17"), count: 1 },
      { term: term("pre2001", "1994-01-01", "2001-06-04", { legacyArchiveUrl: `${LEGACY}/index_pre2001.htm` }), count: 0 },
    ];
    const doc = expectAccessibleStructure(renderTermsIndex(rows, site, {}));
    expect(doc.querySelector("h1")?.textContent).toBe("News archive by government term");
    expect(doc.querySelector("main div.home-body.archive-page > h1")).not.toBeNull();
    expect(doc.querySelector("main div.home-body > div.resource-links > ul.term-list")).not.toBeNull();
    expect(doc.title).toContain("News archive by government term");
    const items = [...doc.querySelectorAll("main ul.term-list > li")];
    expect(items.map((li) => li.querySelector("a")!.getAttribute("href"))).toEqual(["/archive/terms/2024-2028/", "/archive/terms/2020-2024/", `${LEGACY}/index_pre2001.htm`]);
    expect(items.map((li) => li.querySelector("a")!.textContent)).toEqual([
      "November 18, 2024 to current date", "November 26, 2020 to November 17, 2024", "January 1, 1994 to June 4, 2001 (legacy news archive)",
    ]);
    expect(items[0]!.textContent).toContain("Eby <government>");
    expect(items[0]!.textContent).toContain("12 posts");
    expect(items[1]!.textContent).toContain("1 post");
    expect(items[0]!.querySelector("p")?.textContent).toBe("Earlier releases from this term are on the legacy news archive.");
    expect(items[0]!.querySelector(`p a[href="${LEGACY}/index_current.htm"]`)).not.toBeNull();
    expect(items[1]!.querySelector("p")).toBeNull();
    expect(items[2]!.querySelector("p")).toBeNull();
    expect([...doc.querySelectorAll("main .home-body > p, main .resource-links > p")].map((p) => p.textContent)).toContain("Releases from before 2012 are on the legacy news archive (archive.news.gov.bc.ca).");
    expect(doc.querySelector('main a[href="https://archive.news.gov.bc.ca/"]')).not.toBeNull();
  });

  it("the current term with no posts still links to its own page, even with a legacy URL", () => {
    const doc = expectAccessibleStructure(renderTermsIndex([{ term: term("2028-11-20", "2028-11-20", null, { legacyArchiveUrl: `${LEGACY}/x.htm` }), count: 0 }], site, {}));
    expect(doc.querySelector("main ul.term-list a")?.getAttribute("href")).toBe("/archive/terms/2028-11-20/");
  });

  it("an unsafe legacy URL is never a link; no legacy URL at all, no closing line", () => {
    const doc = expectAccessibleStructure(renderTermsIndex([
      { term: term("2020-2024", "2020-11-26", null), count: 3 },
      { term: term("old", "2001-01-01", "2020-11-25", { legacyArchiveUrl: "javascript:alert(1)" }), count: 0 },
    ], site, {}));
    expect(doc.querySelector('main a[href^="javascript"]')).toBeNull();
    expect(doc.querySelector("main")!.textContent).not.toContain("Releases from before 2012");
  });

  it("an empty index says so", () => {
    const doc = expectAccessibleStructure(renderTermsIndex([], site, {}));
    expect(doc.querySelector("main ul.term-list")).toBeNull();
    expect(doc.querySelector("main p")?.textContent).toBe("No government terms have been published yet.");
  });

  it("a term page: range h1, label, every post as an archive card, escaped, canonical to its slug", () => {
    const html = renderTermPage(term("2024-2028", "2024-11-18", null, { label: "Eby & co", legacyArchiveUrl: `${LEGACY}/index_current.htm` }), [indexed("B", "2025-02-01T09:00:00-08:00", "B <i>"), indexed("A", "2024-11-18T00:00:00-08:00")], site, {});
    const doc = expectAccessibleStructure(html);
    expect(doc.querySelector("h1")?.textContent).toBe("News from November 18, 2024 to current date");
    expect(doc.querySelector("main div.home-body#main-content-release.archive-page > h1")).not.toBeNull();
    expect(doc.querySelector("main")!.textContent).toContain("Eby & co");
    const items = [...doc.querySelectorAll("main .regular-articles > div.article")];
    expect(items.map((li) => li.querySelector("h2 a")!.textContent)).toEqual(["B <i>", "A"]);
    expect(items[0]!.querySelector("h2 a")!.getAttribute("href")).toBe("/releases/B/");
    expect(items[0]!.querySelector(".item-date")!.textContent).toBe("Saturday, February 1, 2025 9:00 AM");
    expect(items[0]!.querySelector(".item-text p")!.textContent).toBe("a summary");
    expect(doc.querySelector('link[rel="canonical"]')?.getAttribute("href")).toBe("https://news.example/archive/terms/2024-2028/");
    expect(doc.querySelector('main a[href="/archive/terms/"]')?.textContent).toBe("All government terms");
  });

  it("term page keeps the legacy-archive note", () => {
    const doc = expectAccessibleStructure(renderTermPage(term("2024-2028", "2024-11-18", null, { legacyArchiveUrl: `${LEGACY}/index_current.htm` }), [indexed("A", "2024-11-18T00:00:00-08:00")], site, {}));
    expect(doc.querySelector("main .home-body > p")?.textContent).toBe("Earlier releases from this term are on the legacy news archive.");
    expect(doc.querySelector(`main p a[href="${LEGACY}/index_current.htm"]`)).not.toBeNull();
    const none = expectAccessibleStructure(renderTermPage(term("t", "2024-11-18", null), [], site, {}));
    expect(none.querySelector("main")!.textContent).not.toContain("Earlier releases");
  });

  it("an empty term renders the empty copy; canonicalSlug overrides the canonical", () => {
    const doc = expectAccessibleStructure(renderTermPage(term("2028-11-20", "2028-11-20", null), [], site, { canonicalSlug: "2028-11-20" }));
    expect(doc.querySelector("main .article")).toBeNull();
    expect([...doc.querySelectorAll("main p")].map((p) => p.textContent)).toContain("Nothing has been published in this term yet.");
  });
});

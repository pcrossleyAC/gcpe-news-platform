import { describe, expect, it } from "vitest";
import { expectAccessibleStructure } from "../../test/structure";
import { site } from "../../test/fixtures";
import type { GovernmentTermDto } from "../dto";
import type { IndexedPost } from "../post-index";
import { renderArchiveIndex, renderArchiveMonth, renderTermPage, renderTermsIndex, termRangeLabel } from "./archive";

describe("archives", () => {
  it("the index groups months by year, newest first, with counts", () => {
    const doc = expectAccessibleStructure(renderArchiveIndex([{ month: "2026-10", count: 12 }, { month: "2026-09", count: 1 }, { month: "2025-12", count: 3 }], site, {}));
    expect(doc.querySelector("h1")?.textContent).toBe("News archive");
    expect([...doc.querySelectorAll("h2")].map((h) => h.textContent)).toEqual(["2026", "2025"]);
    expect([...doc.querySelectorAll("main li")].map((li) => li.textContent)).toEqual(["October 2026 (12 posts)", "September 2026 (1 post)", "December 2025 (3 posts)"]);
    expect(doc.querySelector('a[href="/archive/2026/10/"]')).not.toBeNull();
  });
  it("an empty index says so", () => {
    expect(expectAccessibleStructure(renderArchiveIndex([], site, {})).querySelector("main p")?.textContent).toBe("Nothing has been published yet.");
  });
  it("a month lists its posts in the given order, escaped", () => {
    const doc = expectAccessibleStructure(renderArchiveMonth("2026-10", [
      { key: "B", kind: "releases", headline: "B <i>", summary: null, publishDate: "2026-10-05T09:00:00-07:00", month: "2026-10", categories: [] },
      { key: "A", kind: "stories", headline: "A", summary: "S", publishDate: "2026-10-01T09:00:00-07:00", month: "2026-10", categories: [] },
    ], site, {}));
    expect(doc.querySelector("h1")?.textContent).toBe("News from October 2026");
    expect([...doc.querySelectorAll("main ul.post-list a")].map((a) => a.textContent)).toEqual(["B <i>", "A"]);
    // Scoped to main: the header nav also links to /archive/ ("Archive"), which a bare
    // a[href="/archive/"] selector would match first.
    expect(doc.querySelector('main a[href="/archive/"]')?.textContent).toBe("All months");
  });
  it("the index links to the archive by government term", () => {
    const doc = expectAccessibleStructure(renderArchiveIndex([{ month: "2026-10", count: 1 }], site, {}));
    expect(doc.querySelector('main a[href="/archive/terms/"]')?.textContent).toBe("Browse by government term");
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
    expect([...doc.querySelectorAll("main > p")].map((p) => p.textContent)).toContain("Releases from before 2012 are on the legacy news archive (archive.news.gov.bc.ca).");
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

  it("a term page: range h1, label, every post (headline and date, no summary), escaped, canonical to its slug", () => {
    const html = renderTermPage(term("2024-2028", "2024-11-18", null, { label: "Eby & co" }), [indexed("B", "2025-02-01T09:00:00-08:00", "B <i>"), indexed("A", "2024-11-18T00:00:00-08:00")], site, {});
    const doc = expectAccessibleStructure(html);
    expect(doc.querySelector("h1")?.textContent).toBe("News from November 18, 2024 to current date");
    expect(doc.querySelector("main")!.textContent).toContain("Eby & co");
    const items = [...doc.querySelectorAll("main ul.post-list > li")];
    expect(items.map((li) => li.querySelector("a")!.textContent)).toEqual(["B <i>", "A"]);
    expect(items[0]!.querySelector("a")!.getAttribute("href")).toBe("/releases/B/");
    expect(items[0]!.querySelector("time")!.getAttribute("datetime")).toBe("2025-02-01T09:00:00-08:00");
    expect(items[0]!.querySelector("time")!.textContent).toBe("February 1, 2025");
    expect(html).not.toContain("a summary");
    expect(doc.querySelector('link[rel="canonical"]')?.getAttribute("href")).toBe("https://news.example/archive/terms/2024-2028/");
    expect(doc.querySelector('main a[href="/archive/terms/"]')?.textContent).toBe("All government terms");
  });

  it("an empty term renders the empty copy; canonicalSlug overrides the canonical", () => {
    const doc = expectAccessibleStructure(renderTermPage(term("2028-11-20", "2028-11-20", null), [], site, { canonicalSlug: "2028-11-20" }));
    expect(doc.querySelector("main ul.post-list")).toBeNull();
    expect([...doc.querySelectorAll("main p")].map((p) => p.textContent)).toContain("Nothing has been published in this term yet.");
  });
});

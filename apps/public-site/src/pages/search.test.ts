import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { describe, expect, it, vi } from "vitest";
import { expectAccessibleStructure } from "../../test/structure";
import { category, ministry, site } from "../../test/fixtures";
import type { GovernmentTermDto } from "../dto";
import { addDays, termEndExclusive } from "../government-terms";
import { renderSearchPage } from "./search";

const term = (slug: string, startDate: string, endDate: string | null): GovernmentTermDto => ({ slug, label: null, startDate, endDate, legacyArchiveUrl: null });
const TERMS = [term("2024-2028", "2024-11-18", null), term("2020-2024", "2020-11-26", "2024-11-17")];
const ARCHIVE_LINKS = [
  { text: "May 18, 2005 to June 9, 2009", url: "https://archive.news.gov.bc.ca/archive/2005-2009/" },
  { text: "Bad link", url: "javascript:alert(1)" },
];

const page = (apiBase = "") =>
  renderSearchPage(
    {
      ministries: [ministry({ key: "Health", name: "Health & <Care>" }), ministry({ key: "finance", name: "Finance" }), ministry({ key: "gone", name: "Gone", isActive: false })],
      sectors: [category({ key: "Economy", name: "Economy" }), category({ key: "old", name: "Old", isActive: false })],
      terms: TERMS,
    },
    ARCHIVE_LINKS,
    { ...site, baseUrl: "https://boxs.example/site" },
    {},
    apiBase,
  );

const EMPTY = { mode: "text", page: 1, pageSize: 10, total: 0, results: [], facets: null };

/** The page at `qs`, its script run against a stubbed fetch answering `answer` (JSON, 200) or a Response. */
function open(qs: string, answer: unknown = EMPTY) {
  const dom = new JSDOM(page(), { url: `https://boxs.example/site/search/${qs}`, runScripts: "dangerously" });
  const fetchMock = vi.fn(async (_input: string | URL | Request) => (answer instanceof Response ? answer.clone() : new Response(JSON.stringify(answer), { status: 200 })));
  dom.window.fetch = fetchMock as unknown as typeof fetch;
  // jsdom fires DOMContentLoaded itself after construction returns: the script runs once, then.
  const doc = dom.window.document;
  // Settled: the status shows the outcome (not blank, not "Searching…"), or the alert does.
  const settled = () => vi.waitFor(() => expect(!["", "Searching…"].includes(doc.getElementById("search-status")!.textContent ?? "") || doc.getElementById("search-alert")!.textContent !== "").toBe(true));
  const apiUrl = () => String(fetchMock.mock.calls[0]![0]);
  return { dom, doc, fetchMock, settled, apiUrl };
}

const result = (over: Record<string, unknown> = {}) => ({ key: "K1", kind: "releases", headline: "Clinic opens", summary: "First line\nSecond line", publishDate: "2026-10-03T10:00:00-07:00", leadMinistryKey: "health", hasTranslations: false, hasMediaAssets: false, hasTranslationList: false, hasMediaAssetList: false, url: "https://evil.example/", ...over });

describe("search page", () => {
  it("one h1; filter panel with Ministry, Sector, Content, Date (terms, date inputs, older-archive links); Reset search", () => {
    const doc = expectAccessibleStructure(page());
    expect(doc.querySelector(".search .search-body h1")?.textContent).toBe("Search");
    const panel = doc.querySelector(".search .search-panel.search-filters")!;
    expect([...panel.querySelectorAll(".search-filter > h2.open")].map((h) => h.textContent)).toEqual(["Ministry", "Sector", "Content", "Date"]);
    const links = (facet: string) => [...doc.querySelectorAll(`#facet-${facet} li[data-key] a`)].map((a) => [a.textContent, a.getAttribute("href")]);
    // Active ministries with a page, keys lowercased; names escaped, never markup.
    expect(links("ministry")).toEqual([["Health & <Care>", "/site/search/?ministry=health"], ["Finance", "/site/search/?ministry=finance"]]);
    expect(links("sector")).toEqual([["Economy", "/site/search/?sector=economy"]]);
    expect(links("content")).toEqual([["Release", "/site/search/?type=releases"], ["Story", "/site/search/?type=stories"], ["Factsheet", "/site/search/?type=factsheets"], ["Update", "/site/search/?type=updates"]]);
    expect(links("date")).toEqual([
      ["November 18, 2024 to current date", "/site/search/?from=2024-11-18"],
      ["November 26, 2020 to November 17, 2024", "/site/search/?from=2020-11-26&to=2024-11-17"],
    ]);
    const dates = doc.querySelector("#facet-date form.date-range")!;
    expect(dates.getAttribute("action")).toBe("/site/search/");
    expect(dates.getAttribute("method")).toBe("get");
    for (const name of ["from", "to"]) {
      const input = dates.querySelector(`input[type="date"][name="${name}"]`)!;
      expect(dates.querySelector(`label[for="${input.id}"]`)?.textContent?.trim()).toBeTruthy();
    }
    // The older-archive links (pageText.searchArchiveLinks): a safe URL links, an unsafe one is text.
    const archive = [...doc.querySelectorAll("#facet-date li:not([data-key])")];
    expect(archive.map((li) => li.textContent)).toEqual(["May 18, 2005 to June 9, 2009", "Bad link"]);
    expect(archive[0]!.querySelector("a")?.getAttribute("href")).toBe("https://archive.news.gov.bc.ca/archive/2005-2009/");
    expect(archive[1]!.querySelector("a")).toBeNull();
    expect(page()).not.toContain("javascript:");
    const reset = panel.querySelector("a.link-button")!;
    expect([reset.textContent, reset.getAttribute("href")]).toEqual(["Reset search", "/site/search/"]);

    const results = doc.querySelector(".search div.home-body.search-results")!;
    const form = results.querySelector('div.search-panel form#search-form[role="search"]')!;
    expect(form.getAttribute("action")).toBe("/site/search/");
    expect(form.querySelector('label[for="q"]')?.textContent).toBe("You searched for");
    expect(form.querySelector("div.search-panel-bar > input#q[name=q] + button.search-trigger[type=submit][aria-label=Search]")).not.toBeNull();
    expect(results.querySelector('p.search-numbers#search-status[role="status"]')).not.toBeNull();
    expect(results.querySelector('p#search-alert[role="alert"]')).not.toBeNull();
    expect(results.querySelector("div#results")).not.toBeNull();
    expect(results.querySelector('nav.search-pagination.bottom[aria-label="Search pages"]')).not.toBeNull();
    // The header's search forms are left off, as legacy does; the phone toggle links to this box (R12).
    expect(doc.querySelector("header form, #smd-search-container")).toBeNull();
    expect(doc.querySelector("header a#search-md-button")?.getAttribute("href")).toBe("#q");
    expect(doc.querySelector("noscript")?.innerHTML).toContain("/site/archive/");
  });

  it("escapes the API base", () => {
    expect(page('https://api.example/"x')).toContain('data-api-base="https://api.example/&quot;x"');
  });

  it("?q=x calls /api/v2/search?q=x&page=1&pageSize=10&facets=1", async () => {
    const { fetchMock, apiUrl, settled } = open("?q=x");
    await settled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(apiUrl()).toBe("https://boxs.example/api/v2/search?q=x&page=1&pageSize=10&facets=1");
  });

  it.each([
    ["?content=factsheets%20%26%20opinion%20editorials", "type=factsheets", "?type=factsheets"],
    ["?Ministry=Health", "ministry=health", "?ministry=health"],
    ["?Ministry=health%20%26%20%3Ccare%3E", "ministry=health", "?ministry=health"],
    ["?Content=Story", "type=stories", "?type=stories"],
    ["?Content=Release&q=bridge", "q=bridge&type=releases", "?q=bridge&type=releases"],
    ["?content=updates", "type=updates", "?type=updates"],
    ["?type=stories", "type=stories", "?type=stories"],
    ["?Sector=ECONOMY", "sector=economy", "?sector=economy"],
  ])("legacy: %s → %s", async (qs, api, mapped) => {
    const { dom, apiUrl, settled } = open(qs);
    await settled();
    expect(apiUrl()).toBe(`https://boxs.example/api/v2/search?${api}&page=1&pageSize=10&facets=1`);
    // The page stays on the mapped URL.
    expect(dom.window.location.pathname + dom.window.location.search).toBe(`/site/search/${mapped}`);
  });

  it.each([
    ["?fromDate=2020/11/26&toDate=2024/11/17", "from=2020-11-26&to=2024-11-17&page=1"],
    ["?from=2020-11-26&to=2024-11-17", "from=2020-11-26&to=2024-11-17&page=1"],
    ["?Date=2020-2024", "from=2020-11-26&to=2024-11-17&page=1"],
    ["?Date=2024-2028&q=x", "q=x&from=2024-11-18&page=1"],
    ["?Page=3&q=x", "q=x&page=3"],
    // Reversed dates are swapped, never sent as the API's 400.
    ["?from=2024-11-17&to=2020-11-26", "from=2020-11-26&to=2024-11-17&page=1"],
    // An impossible date, a page past the API's last (1000 / 10) and a junk page.
    ["?q=x&fromDate=2020/02/30&page=500", "q=x&page=100"],
    ["?q=x&page=abc", "q=x&page=1"],
    // Outside the API's 1900–2199 dates (its 400): dropped.
    ["?q=x&from=1066-10-14&toDate=2200/01/01", "q=x&page=1"],
  ])("legacy: %s → %s", async (qs, api) => {
    const { apiUrl, settled } = open(qs);
    await settled();
    expect(apiUrl()).toBe(`https://boxs.example/api/v2/search?${api}&pageSize=10&facets=1`);
  });

  it("?Language=French and ?Ministry=Nowhere are dropped; no 400 shown", async () => {
    const a = open("?q=x&Language=French&Ministry=Nowhere&City=Victoria&Date=1066-1067");
    await a.settled();
    expect(a.apiUrl()).toBe("https://boxs.example/api/v2/search?q=x&page=1&pageSize=10&facets=1");
    expect(a.dom.window.location.search).toBe("?q=x");
    expect(a.doc.getElementById("search-alert")!.textContent).toBe("");
    // Nothing left to search: no request at all, no message.
    const b = open("?Ministry=Nowhere&Language=French");
    await new Promise((r) => setTimeout(r, 20));
    expect(b.fetchMock).not.toHaveBeenCalled();
    expect(b.doc.getElementById("search-alert")!.textContent).toBe("");
    expect(b.dom.window.location.search).toBe("");
  });

  it("nothing read from location becomes markup", async () => {
    const { doc, dom, apiUrl, settled } = open("?q=%3Cimg%20src%3Dx%20onerror%3Dalert(1)%3E&ministry=%3Cscript%3E");
    await settled();
    expect(apiUrl()).toBe("https://boxs.example/api/v2/search?q=%3Cimg+src%3Dx+onerror%3Dalert%281%29%3E&page=1&pageSize=10&facets=1");
    expect((doc.getElementById("q") as HTMLInputElement).value).toBe("<img src=x onerror=alert(1)>");
    expect(doc.querySelector("main img")).toBeNull();
    expect(doc.querySelectorAll("main script")).toHaveLength(1);
    expect(dom.window.location.search).toBe("?q=%3Cimg+src%3Dx+onerror%3Dalert%281%29%3E");
  });

  it("results render as div.article cards with Translations link when there is a list, date with time, Read More; headline text never becomes markup", async () => {
    const hostile = "<img src=x onerror=alert(1)>";
    const { doc, settled } = open("?q=clinic", {
      ...EMPTY,
      total: 3,
      results: [
        result({ headline: hostile, summary: `${hostile}\nSecond line`, hasTranslations: true, hasMediaAssets: true, hasTranslationList: true, hasMediaAssetList: true }),
        // Flagged in legacy but no files listed: no links (they would lead to nothing).
        result({ key: "K2", headline: null, summary: null, hasTranslations: true, hasMediaAssets: true }),
        // A key that is not a post key never becomes a link.
        result({ key: "../evil", headline: "Evil" }),
      ],
    });
    await settled();
    const cards = [...doc.querySelectorAll("#results > div.article")];
    expect(cards).toHaveLength(2);
    const card = cards[0]!;
    const h = card.querySelector(":scope > h2 > a")!;
    expect(h.textContent).toBe(hostile);
    expect(h.getAttribute("href")).toBe("/site/releases/K1/");
    expect(card.querySelector(":scope > div.item-medialink.translations > a")?.getAttribute("href")).toBe("/site/releases/K1/#translations");
    expect(card.querySelector(":scope > div.item-medialink.translations")?.textContent?.trim()).toBe("Translations");
    expect(card.querySelector(":scope > div.item-medialink.media-assets > a")?.getAttribute("href")).toBe("/site/releases/K1/#assets");
    expect(card.querySelector(":scope > div.item-date")?.textContent).toBe("Saturday, October 3, 2026 10:00 AM");
    const text = card.querySelector(":scope > div.item-content > div.item-text")!;
    expect([...text.querySelectorAll(":scope > p")].map((p) => p.textContent)).toEqual([hostile, "Second line"]);
    const more = text.querySelector(":scope > a.read-more")!;
    expect(more.getAttribute("href")).toBe("/site/releases/K1/");
    expect(more.textContent).toContain("Read More");
    // Child order as legacy: h2, translations, media assets, date, content.
    expect([...card.children].map((c) => c.className || c.tagName.toLowerCase())).toEqual(["h2", "item-medialink translations", "item-medialink media-assets", "item-date", "item-content", "clear"]);
    expect(doc.querySelector("#results img, #results script")).toBeNull();
    expect(doc.getElementById("results")!.innerHTML).not.toContain("evil.example");
    // Flags without lists: no Translations or Media Assets; no headline: the key.
    expect(cards[1]!.querySelector(".item-medialink")).toBeNull();
    expect(cards[1]!.querySelector("h2 a")?.textContent).toBe("K2");
    expect(doc.getElementById("results")!.textContent).not.toContain("Evil");
  });

  it("Showing results 11 - 20 of 585 on page 2; pagination next/previous and aria-current", async () => {
    const results = Array.from({ length: 10 }, (_, i) => result({ key: `K${i + 11}` }));
    const { doc, settled } = open("?q=x&page=2", { ...EMPTY, page: 2, total: 585, results });
    await settled();
    expect(doc.getElementById("search-status")!.textContent).toBe("Showing results 11 - 20 of 585");
    const nav = doc.querySelector('nav.search-pagination.bottom[aria-label="Search pages"]')!;
    const items = [...nav.querySelectorAll("ul > li")].map((li) => li.textContent);
    expect(items).toEqual(["« previous", "1", "2", "3", "4", "5", "next »"]);
    const current = nav.querySelector('b[aria-current="page"]')!;
    expect(current.textContent).toBe("2");
    const href = (text: string) => [...nav.querySelectorAll("a")].find((a) => a.textContent === text)!.getAttribute("href");
    expect(href("« previous")).toBe("/site/search/?q=x");
    expect(href("next »")).toBe("/site/search/?q=x&page=3");
    expect(href("5")).toBe("/site/search/?q=x&page=5");
  });

  it("pagination keeps five numbers around the current page and stops at the last", async () => {
    const results = Array.from({ length: 5 }, (_, i) => result({ key: `K${i}` }));
    const mid = open("?q=x&page=50", { ...EMPTY, page: 50, total: 1234, results });
    await mid.settled();
    expect([...mid.doc.querySelectorAll(".search-pagination li")].map((li) => li.textContent)).toEqual(["« previous", "48", "49", "50", "51", "52", "next »"]);
    const last = open("?q=x&page=124", { ...EMPTY, page: 100, total: 1234, results });
    await last.settled();
    // 1,234 results is 124 pages, but the API stops at page 100.
    expect(last.doc.getElementById("search-status")!.textContent).toBe("Showing results 991 - 995 of 1,234");
    expect([...last.doc.querySelectorAll(".search-pagination li")].map((li) => li.textContent)).toEqual(["« previous", "96", "97", "98", "99", "100"]);
    const one = open("?q=x", { ...EMPTY, total: 3, results: results.slice(0, 3) });
    await one.settled();
    expect(one.doc.querySelector(".search-pagination ul")).toBeNull();
  });

  it("no results: says so", async () => {
    const { doc, settled } = open("?q=x");
    await settled();
    expect(doc.getElementById("search-status")!.textContent).toBe("No results found.");
  });

  it("ministry, sector and content entries are ordered by count, largest first, as legacy's facets; dates keep their order", async () => {
    const facets = { ministries: [{ key: "health", count: 2 }, { key: "finance", count: 9 }], sectors: [], types: [{ key: "releases", count: 1 }, { key: "stories", count: 5 }], terms: [] };
    const { doc, settled } = open("?q=x", { ...EMPTY, total: 3, results: [result()], facets });
    await settled();
    const shown = (facet: string) => [...doc.querySelectorAll(`#facet-${facet} li[data-key]`)].filter((li) => !(li as HTMLElement).hidden).map((li) => li.textContent);
    expect(shown("ministry")).toEqual(["Finance: 9", "Health & <Care>: 2"]);
    expect(shown("content")).toEqual(["Story: 5", "Release: 1"]);
  });

  it("facet counts reduce the lists; facets null keeps the baked lists", async () => {
    const facets = { ministries: [{ key: "health", count: 1234 }], sectors: [], types: [{ key: "releases", count: 2 }, { key: "stories", count: 1 }], terms: [{ slug: "2024-2028", count: 3 }] };
    const { doc, settled } = open("?q=x", { ...EMPTY, total: 3, results: [result()], facets });
    await settled();
    const shown = (facet: string) => [...doc.querySelectorAll(`#facet-${facet} li[data-key]`)].filter((li) => !(li as HTMLElement).hidden).map((li) => li.textContent);
    expect(shown("ministry")).toEqual(["Health & <Care>: 1,234"]);
    expect(shown("sector")).toEqual([]);
    expect(shown("content")).toEqual(["Release: 2", "Story: 1"]);
    expect(shown("date")).toEqual(["November 18, 2024 to current date: 3"]);
    // The older-archive links are not facet entries: they stay.
    expect([...doc.querySelectorAll("#facet-date li:not([data-key])")].every((li) => !(li as HTMLElement).hidden)).toBe(true);

    const plain = open("?q=x", { ...EMPTY, mode: "semantic", total: 1, results: [result()], facets: null });
    await plain.settled();
    const all = (facet: string) => [...plain.doc.querySelectorAll(`#facet-${facet} li[data-key]`)].filter((li) => !(li as HTMLElement).hidden).map((li) => li.textContent);
    expect(all("ministry")).toEqual(["Health & <Care>", "Finance"]);
    expect(all("sector")).toEqual(["Economy"]);
    expect(all("content")).toHaveLength(4);
    expect(all("date")).toHaveLength(2);
  });

  it("facet links add their filter to the current search; an active filter shows a Remove link", async () => {
    const { doc, settled } = open("?q=x&ministry=health&page=3", { ...EMPTY, page: 3, total: 30, results: [result()], facets: null });
    await settled();
    const href = (sel: string) => doc.querySelector(sel)!.getAttribute("href");
    expect(href('#facet-sector li[data-key="economy"] a')).toBe("/site/search/?q=x&ministry=health&sector=economy");
    expect(href('#facet-date li[data-key="2020-2024"] a')).toBe("/site/search/?q=x&ministry=health&from=2020-11-26&to=2024-11-17");
    // The Ministry group shows only the chosen ministry, with a link that removes it.
    const ministryItems = [...doc.querySelectorAll("#facet-ministry li")].filter((li) => !(li as HTMLElement).hidden);
    expect(ministryItems.map((li) => li.textContent)).toEqual(["Health & <Care> Remove Ministry filter"]);
    const remove = doc.querySelector("#facet-ministry a.remove-filter")!;
    expect(remove.textContent).toBe("Remove Ministry filter");
    expect(remove.getAttribute("href")).toBe("/site/search/?q=x");
    // A new text search keeps the filters (hidden inputs, built as elements), from page 1.
    const form = doc.getElementById("search-form")!;
    expect([...form.querySelectorAll("input[type=hidden]")].map((i) => [(i as HTMLInputElement).name, (i as HTMLInputElement).value])).toEqual([["ministry", "health"]]);
  });

  it("a custom date range is the active Date filter; the date inputs show it", async () => {
    const { doc, settled } = open("?q=x&fromDate=2021/01/02&toDate=2021/03/04", { ...EMPTY, total: 1, results: [result()], facets: null });
    await settled();
    expect((doc.querySelector('#facet-date input[name="from"]') as HTMLInputElement).value).toBe("2021-01-02");
    expect((doc.querySelector('#facet-date input[name="to"]') as HTMLInputElement).value).toBe("2021-03-04");
    const remove = doc.querySelector("#facet-date a.remove-filter")!;
    expect(remove.textContent).toBe("Remove Date filter");
    expect(remove.getAttribute("href")).toBe("/site/search/?q=x");
    // The date form carries the text and other filters along.
    expect([...doc.querySelectorAll("#facet-date form.date-range input[type=hidden]")].map((i) => [(i as HTMLInputElement).name, (i as HTMLInputElement).value])).toEqual([["q", "x"]]);
  });

  // The term facet's link is the term page's own window: [startDate, endDate + 1 day), BC days
  // (archive-by-term's inDayRange), so a facet count and the term page agree.
  it("a term facet maps to the same from/to the term page uses", () => {
    const doc = new JSDOM(page()).window.document;
    for (const t of TERMS) {
      const params = new URL(doc.querySelector(`#facet-date li[data-key="${t.slug}"] a`)!.getAttribute("href")!, "https://x.example").searchParams;
      expect(params.get("from")).toBe(t.startDate);
      const to = params.get("to");
      // The API's `to` is inclusive (it searches up to the next day's start).
      expect(to === null ? null : addDays(to, 1)).toBe(termEndExclusive(t));
    }
  });

  it.each([
    [400, "Enter between 1 and 200 characters to search."],
    [429, "Too many searches. Wait a minute and try again."],
    [500, "Search isn't available right now. You can browse the archive instead."],
  ])("a %i answer shows a message in the alert region", async (status, message) => {
    const { doc } = open("?q=x", new Response("{}", { status }));
    await vi.waitFor(() => expect(doc.getElementById("search-alert")!.textContent).toBe(message));
  });

  it("a network failure shows the generic message, never the error's own text", async () => {
    const dom = new JSDOM(page(), { url: "https://boxs.example/site/search/?q=x", runScripts: "dangerously" });
    dom.window.fetch = (async () => { throw new Error("secret upstream detail"); }) as unknown as typeof fetch;
    const alertEl = dom.window.document.getElementById("search-alert")!;
    await vi.waitFor(() => expect(alertEl.textContent).toBe("Search isn't available right now. You can browse the archive instead."));
  });

  it("no query and no filter: no request", async () => {
    const { fetchMock } = open("");
    await new Promise((r) => setTimeout(r, 20));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("the results come before the filters in the DOM (reading and focus order, WCAG 1.3.2/2.4.3); CSS floats them right at desktop, with no order rules", () => {
    const doc = expectAccessibleStructure(page());
    const kids = [...doc.querySelector("div.search")!.children].map((c) => c.className);
    expect(kids.indexOf("home-body search-results")).toBeLessThan(kids.indexOf("search-panel search-filters"));
    const overrides = readFileSync(new URL("../../assets/site/overrides.css", import.meta.url), "utf8");
    const searchCss = overrides.slice(overrides.indexOf("/* The search page (pages/search.ts)"), overrides.indexOf("/* Archive pages")).replace(/\/\*[\s\S]*?\*\//g, "");
    expect(searchCss).not.toMatch(/\border\s*:/);
    expect(searchCss).toMatch(/\.search>\.search-results\{[^}]*float:right[^}]*width:76%/);
    expect(searchCss).toMatch(/\.search>\.search-filters\{[^}]*float:left[^}]*width:24%/);
  });

  it("the count is the cards shown: a result with a bad key is skipped and not counted", async () => {
    const results = [...Array.from({ length: 8 }, (_, i) => result({ key: `K${i + 11}` })), result({ key: "bad key!" }), result({ key: "" })];
    const { doc, settled } = open("?q=x&page=2", { ...EMPTY, page: 2, total: 585, results });
    await settled();
    expect(doc.querySelectorAll("#results .article")).toHaveLength(8);
    expect(doc.getElementById("search-status")!.textContent).toBe("Showing results 11 - 18 of 585");
  });

  it("a page past the end says so, links to page 1 and keeps the pages (previous goes to the last page)", async () => {
    const { doc, settled } = open("?q=x&page=7", { ...EMPTY, page: 7, total: 12, results: [] });
    await settled();
    expect(doc.getElementById("search-status")!.textContent).toBe("There are no results on page 7. This search has 12 results.");
    const first = doc.querySelector<HTMLAnchorElement>("#results a.first-page")!;
    expect([first.textContent, first.getAttribute("href")]).toEqual(["Go to the first page of results", "/site/search/?q=x"]);
    const nav = doc.getElementById("search-pages")!;
    expect(nav.hidden).toBe(false);
    expect([...nav.querySelectorAll("li")].map((li) => li.textContent)).toEqual(["« previous", "1", "2"]);
    expect([...nav.querySelectorAll("a")].find((a) => a.textContent === "« previous")!.getAttribute("href")).toBe("/site/search/?q=x&page=2");
  });

  it("strips NUL characters from q before searching and showing it", async () => {
    const { doc, settled, apiUrl } = open("?q=a%00b%00");
    await settled();
    expect(new URL(apiUrl()).searchParams.get("q")).toBe("ab");
    expect(doc.querySelector<HTMLInputElement>("#q")!.value).toBe("ab");
  });

  it("a total or a facet count that isn't a finite number is never shown (Infinity, text)", async () => {
    const facets = { ministries: [{ key: "health", count: "Infinity" }, { key: "finance", count: 2 }], sectors: [], types: [], terms: [] };
    const { doc, settled } = open("?q=x", { ...EMPTY, total: "Infinity", results: [result()], facets });
    await settled();
    expect(doc.getElementById("search-status")!.textContent).toBe("Showing results 1 - 1 of 1");
    expect(doc.querySelector<HTMLElement>('#facet-ministry li[data-key="health"]')!.hidden).toBe(true);
    expect(doc.querySelector('#facet-ministry li[data-key="finance"]')!.textContent).toBe("Finance: 2");
    for (const sel of ["#search-status", "#results", ".search-filters"]) expect(doc.querySelector(sel)!.textContent).not.toContain("Infinity");
  });
});

import { JSDOM } from "jsdom";
import { describe, expect, it, vi } from "vitest";
import { expectAccessibleStructure } from "../../test/structure";
import { ministry, site } from "../../test/fixtures";
import { renderSearchPage } from "./search";

const page = (apiBase = "") => renderSearchPage([ministry({ key: "health", name: "Health & <Care>" }), ministry({ key: "gone", name: "Gone", isActive: false })], { ...site, baseUrl: "https://boxs.example/site" }, {}, apiBase);

describe("search page", () => {
  it("is accessible: a labelled search form, one h1, live regions, a noscript fallback", () => {
    const doc = expectAccessibleStructure(page());
    expect(doc.querySelector("h1")?.textContent).toBe("Search news");
    const form = doc.querySelector('main form[role="search"]')!; // the header has its own two
    expect(form.getAttribute("action")).toBe("/site/search/");
    expect(form.querySelector('label[for="q"]')?.textContent).toBe("Search for");
    expect(form.querySelector("#q")?.getAttribute("maxlength")).toBe("200");
    expect([...form.querySelectorAll("#ministry option")].map((o) => o.textContent)).toEqual(["All ministries", "Health & <Care>"]);
    expect(doc.querySelector('[role="status"]')).not.toBeNull();
    expect(doc.querySelector('[role="alert"]')).not.toBeNull();
    expect(doc.querySelector("noscript")?.innerHTML).toContain("/site/archive/");
  });

  it("escapes ministry names and the API base", () => {
    expect(page('https://api.example/"x')).toContain('data-api-base="https://api.example/&quot;x"');
    expect(page()).toContain("Health &amp; &lt;Care&gt;");
  });

  it("the script fetches /api/v2/search and builds results with text only", async () => {
    const dom = new JSDOM(page(), { url: "https://boxs.example/site/search/?q=clinic%20%3Cb%3E&ministry=health&page=2", runScripts: "dangerously" });
    const fetchMock = vi.fn(async (_input: string | URL | Request) => new Response(JSON.stringify({ mode: "text", page: 2, total: 41, results: [{ key: "K1", kind: "releases", headline: "<img src=x onerror=alert(1)>", summary: "S", publishDate: "2026-10-03T10:00:00-07:00", leadMinistryKey: "health", url: "https://evil.example/" }] }), { status: 200 }));
    dom.window.fetch = fetchMock as unknown as typeof fetch;
    dom.window.document.dispatchEvent(new dom.window.Event("DOMContentLoaded"));
    await vi.waitFor(() => expect(dom.window.document.querySelector("#results li")).not.toBeNull());
    expect(fetchMock.mock.calls[0]![0]).toBe("https://boxs.example/api/v2/search?q=clinic+%3Cb%3E&ministry=health&page=2");
    const link = dom.window.document.querySelector("#results li a")!;
    expect(link.getAttribute("href")).toBe("/site/releases/K1/");
    expect(link.textContent).toBe("<img src=x onerror=alert(1)>");
    expect(dom.window.document.querySelector("#results img")).toBeNull();
    expect(dom.window.document.querySelector('[role="status"]')?.textContent).toBe("Results 21 to 21 of 41.");
    expect(dom.window.document.querySelector('nav[aria-label="Search results pages"] a[rel="prev"]')?.getAttribute("href")).toContain("page=1");
    expect((dom.window.document.querySelector("#q") as HTMLInputElement).value).toBe("clinic <b>");
  });

  it.each([
    [400, "Enter between 1 and 200 characters to search."],
    [429, "Too many searches. Wait a minute and try again."],
    [500, "Search isn't available right now. You can browse the archive instead."],
  ])("a %i answer shows a message in the alert region", async (status, message) => {
    const dom = new JSDOM(page(), { url: "https://boxs.example/site/search/?q=x", runScripts: "dangerously" });
    dom.window.fetch = (async () => new Response("{}", { status })) as unknown as typeof fetch;
    dom.window.document.dispatchEvent(new dom.window.Event("DOMContentLoaded"));
    await vi.waitFor(() => expect(dom.window.document.querySelector('[role="alert"]')?.textContent).toBe(message));
  });

  // The ministry page's "Search <ministry> news" link is /search/?ministry=<key>, with no text.
  // Legacy lists that ministry's posts, newest first; so does the API now for a filter alone.
  it("a ministry and no text runs a filter-only search, headed with the ministry's name", async () => {
    const dom = new JSDOM(page(), { url: "https://boxs.example/site/search/?ministry=health", runScripts: "dangerously" });
    const fetchMock = vi.fn(async (_input: string | URL | Request) => new Response(JSON.stringify({ mode: "text", page: 1, total: 2, results: [
      { key: "NEW", kind: "releases", headline: "Newer", summary: null, publishDate: "2026-10-03T10:00:00-07:00", leadMinistryKey: "health", url: "" },
      { key: "OLD", kind: "releases", headline: "Older", summary: null, publishDate: "2026-10-01T10:00:00-07:00", leadMinistryKey: "health", url: "" },
    ] }), { status: 200 }));
    dom.window.fetch = fetchMock as unknown as typeof fetch;
    // jsdom fires DOMContentLoaded itself once construction returns; no second, manual dispatch
    // here, so the script runs exactly once and the list is exactly this page.
    await vi.waitFor(() => expect(dom.window.document.querySelectorAll("#results li")).toHaveLength(2));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]![0]).toBe("https://boxs.example/api/v2/search?ministry=health&page=1");
    expect([...dom.window.document.querySelectorAll("#results li a")].map((a) => a.textContent)).toEqual(["Newer", "Older"]);
    const heading = dom.window.document.querySelector("#results-heading")!;
    expect(heading.hasAttribute("hidden")).toBe(false);
    expect(heading.textContent).toBe("Latest Health & <Care> news");
    expect(dom.window.document.querySelector('[role="status"]')?.textContent).toBe("Results 1 to 2 of 2.");
    expect((dom.window.document.querySelector("#q") as HTMLInputElement).value).toBe("");
    expect((dom.window.document.querySelector("#ministry") as HTMLSelectElement).value).toBe("health");
  });

  it("a sector alone also runs a filter-only search; an unknown ministry key is headed generically", async () => {
    for (const [qs, expected, title] of [
      ["sector=economy", "https://boxs.example/api/v2/search?sector=economy&page=1", "Latest news"],
      ["ministry=no-such&page=2", "https://boxs.example/api/v2/search?ministry=no-such&page=2", "Latest news"],
    ] as const) {
      const dom = new JSDOM(page(), { url: `https://boxs.example/site/search/?${qs}`, runScripts: "dangerously" });
      const fetchMock = vi.fn(async () => new Response(JSON.stringify({ mode: "text", page: 1, total: 0, results: [] }), { status: 200 }));
      dom.window.fetch = fetchMock as unknown as typeof fetch;
      dom.window.document.dispatchEvent(new dom.window.Event("DOMContentLoaded"));
      await vi.waitFor(() => expect(dom.window.document.querySelector('[role="status"]')?.textContent).toBe("No results."));
      expect((fetchMock.mock.calls[0] as unknown[])[0]).toBe(expected);
      expect(dom.window.document.querySelector("#results-heading")?.textContent).toBe(title);
    }
  });

  it("with text, the results heading stays 'Results'", async () => {
    const dom = new JSDOM(page(), { url: "https://boxs.example/site/search/?q=x&ministry=health", runScripts: "dangerously" });
    dom.window.fetch = (async () => new Response(JSON.stringify({ mode: "text", page: 1, total: 0, results: [] }), { status: 200 })) as unknown as typeof fetch;
    dom.window.document.dispatchEvent(new dom.window.Event("DOMContentLoaded"));
    await vi.waitFor(() => expect(dom.window.document.querySelector('[role="status"]')?.textContent).toBe("No results."));
    expect(dom.window.document.querySelector("#results-heading")?.textContent).toBe("Results");
  });

  it("the form can be sent with only a ministry chosen (text is optional)", () => {
    const doc = expectAccessibleStructure(page());
    expect(doc.querySelector("#q")?.hasAttribute("required")).toBe(false);
  });

  it("no query and no filter: no request", () => {
    const dom = new JSDOM(page(), { url: "https://boxs.example/site/search/", runScripts: "dangerously" });
    const fetchMock = vi.fn();
    dom.window.fetch = fetchMock as unknown as typeof fetch;
    dom.window.document.dispatchEvent(new dom.window.Event("DOMContentLoaded"));
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

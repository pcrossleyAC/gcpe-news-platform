import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { expectAccessibleStructure } from "../test/structure";
import { memoryStorage } from "../test/memory-storage";
import { renderNotFoundPage, renderRobots, writeStaticPages } from "./static-pages";
import { writeBuiltinAssets } from "./site-assets";
import type { SiteStorage } from "./storage";
import { DEFAULT_THEME } from "./theme-css";
import { bcSettings } from "../test/fixtures";

const site = { name: "BC Gov News", baseUrl: "https://news.example", theme: DEFAULT_THEME };

/** The folder's files other than the built-in assets writeStaticPages also writes (site-assets.test.ts covers those). */
async function tenantKeys(storage: ReturnType<typeof memoryStorage>): Promise<string[]> {
  const builtin = memoryStorage();
  await writeBuiltinAssets(builtin as SiteStorage);
  return [...storage.files.keys()].filter((k) => !builtin.files.has(k)).sort();
}

describe("static pages", () => {
  it("404 is an accessible page with a way home", () => {
    const doc = expectAccessibleStructure(renderNotFoundPage(site, {}));
    expect(doc.querySelector("h1")?.textContent).toBe("Page not found");
    expect(doc.querySelector('main a[href="/"]')).not.toBeNull();
  });
  it("404 renders inside the full chrome: header#main-nav, one h1, footer#footer, a labelled search form posting to {base}/search/", () => {
    const doc = expectAccessibleStructure(renderNotFoundPage({ ...site, baseUrl: "https://news.example/site" }, {}));
    expect(doc.querySelector("header#main-nav")).not.toBeNull();
    expect(doc.querySelector("footer#footer")).not.toBeNull();
    expect(doc.querySelectorAll("h1")).toHaveLength(1);
    const body = doc.querySelector("main > div.home-body.not-found")!;
    expect(body.querySelector("h1")?.textContent).toBe("Page not found");
    const form = body.querySelector("form")!;
    expect(form.className).toBe("search-panel-bar");
    expect(form.getAttribute("role")).toBe("search");
    // Named, so it is distinguishable from the header's two "Site search" landmarks.
    expect(form.getAttribute("aria-label")).toBe("Search for the page");
    const names = [...doc.querySelectorAll('[role="search"]')].map((f) => f.getAttribute("aria-label"));
    expect(names.every(Boolean)).toBe(true);
    expect(new Set(names).size).toBeGreaterThan(1);
    expect(form.getAttribute("action")).toBe("/site/search/");
    expect(form.getAttribute("method")).toBe("get");
    expect(form.hasAttribute("data-prefill-from-path")).toBe(true);
    const input = form.querySelector("input#not-found-q")!;
    expect(input.getAttribute("name")).toBe("q");
    expect(input.getAttribute("type")).toBe("search");
    expect(input.hasAttribute("value")).toBe(false);
    expect(form.querySelector('label[for="not-found-q"]')?.textContent).toBe("Search for the page");
    expect(form.querySelector('button[type="submit"]')?.textContent).toBe("Search");
    expect(body.querySelector('a[href="/site/archive/"]')).not.toBeNull();
  });
  it("404.html shows the settings heading as h1 and the text; the search form is still prefilled from the path", () => {
    const settings = bcSettings();
    settings.pageText.notFound = { heading: "Gone <fishing>", text: "Try the search & more." };
    const html = renderNotFoundPage(site, { settings });
    const doc = expectAccessibleStructure(html);
    expect(doc.querySelectorAll("h1")).toHaveLength(1);
    expect(doc.querySelector("main h1")?.textContent).toBe("Gone <fishing>");
    expect(doc.querySelector("main .not-found > p")?.textContent).toBe("Try the search & more.");
    expect(html).not.toContain("<fishing>");
    expect(doc.querySelector("main form[data-prefill-from-path]")).not.toBeNull();
    expect(doc.querySelector("title")?.textContent).toContain("Gone <fishing>");
    // Empty strings do not crash, leave no blank h1 and no empty line where the text was.
    settings.pageText.notFound = { heading: " ", text: "" };
    const empty = renderNotFoundPage(site, { settings });
    const emptyDoc = expectAccessibleStructure(empty);
    expect(emptyDoc.querySelector("main h1")?.textContent).toBe("Page not found");
    expect(emptyDoc.querySelector("title")?.textContent).toContain("Page not found");
    expect(empty).toContain('<h1>Page not found</h1>\n<form class="search-panel-bar"');
  });
  it("renderRobots (not test) is exactly the legacy Disallows without /assets, plus our Sitemap line", () => {
    expect(renderRobots({ ...site, baseUrl: "https://news.gov.bc.ca" }, false)).toBe(
      "User-agent: *\nDisallow: /error\nDisallow: /files\nDisallow: /search\nDisallow: /Search\nDisallow: /SEARCH\nDisallow: /subscribe\nSitemap: https://news.gov.bc.ca/sitemap.xml\n",
    );
    expect(renderRobots({ ...site, baseUrl: "https://news.example/site" }, false)).toContain("Sitemap: https://news.example/site/sitemap.xml\n");
    expect(renderRobots(site, false)).not.toContain("/assets");
  });
  it("renderRobots (test) is still Disallow: /", () => {
    expect(renderRobots(site, true)).toBe("User-agent: *\nDisallow: /\n");
  });
  it("writeStaticPages writes google790b0529c8dcfaff.html containing 'google-site-verification: google790b0529c8dcfaff.html' when set, and nothing when unset", async () => {
    const f = "google790b0529c8dcfaff.html";
    const set = memoryStorage();
    await writeStaticPages(set as SiteStorage, { ...site, verification: { googleFile: f, googleMeta: null } }, { settings: bcSettings() }, null);
    expect(set.files.get(f)).toContain(`google-site-verification: ${f}`);
    for (const v of [undefined, { googleFile: null, googleMeta: null }, { googleFile: "../x.html", googleMeta: null }]) {
      const unset = memoryStorage();
      await writeStaticPages(unset as SiteStorage, { ...site, verification: v }, { settings: bcSettings() }, null);
      expect(await tenantKeys(unset)).toEqual(["404.html", "assets/site-banner.json", "assets/theme.css", "robots.txt"]);
    }
  });
  it("writes theme.css, 404.html, robots.txt and copies the assets folder", async () => {
    const dir = await mkdtemp(join(tmpdir(), "site-assets-"));
    await mkdir(join(dir, "assets", "img"), { recursive: true });
    await writeFile(join(dir, "assets", "logo.svg"), "<svg/>");
    await writeFile(join(dir, "assets", "img", "a.png"), Buffer.from([0x89, 0x50]));
    await writeFile(join(dir, "assets", ".hidden"), "x");
    const storage = memoryStorage();
    await writeStaticPages(storage, site, { test: true }, dir);
    expect(await tenantKeys(storage)).toEqual(["404.html", "assets/img/a.png", "assets/logo.svg", "assets/site-banner.json", "assets/theme.css", "robots.txt"]);
    expect(storage.files.get("assets/img/a.png")).toBeInstanceOf(Uint8Array);
  });
  it("skips every file inside a hidden directory, not just a dotfile's own name", async () => {
    const dir = await mkdtemp(join(tmpdir(), "site-assets-"));
    await mkdir(join(dir, "assets", ".git"), { recursive: true });
    await writeFile(join(dir, "assets", ".git", "config"), "x");
    await writeFile(join(dir, "assets", "logo.svg"), "<svg/>");
    const storage = memoryStorage();
    await writeStaticPages(storage, site, {}, dir);
    expect(await tenantKeys(storage)).toEqual(["404.html", "assets/logo.svg", "assets/site-banner.json", "assets/theme.css", "robots.txt"]);
  });
  it("a missing assets folder is not an error", async () => {
    const storage = memoryStorage();
    await writeStaticPages(storage, site, {}, "/nonexistent/folder");
    expect(storage.files.has("assets/theme.css")).toBe(true);
  });
  it("theme.css carries the settings colours and the banner variables", async () => {
    const storage = memoryStorage();
    const settings = bcSettings();
    settings.theme.colors = { ...settings.theme.colors, primary: "#123456", bannerEmergency: "#A12B2B" };
    await writeStaticPages(storage, site, { settings }, null);
    const css = storage.files.get("assets/theme.css") as string;
    expect(css).toContain("--color-primary: #123456;");
    expect(css).toContain("--color-banner-info: #013366;");
    expect(css).toContain("--color-banner-emergency: #A12B2B;");
  });
  it("assets/site-banner.json is the banner the inline script reads", async () => {
    const storage = memoryStorage();
    const settings = bcSettings();
    settings.banner = { enabled: true, style: "emergency", message: "Evacuation order", links: [{ text: "Details", url: "/alerts" }], dismissible: false, startsAt: "2026-11-02T09:00:00-08:00", endsAt: null };
    await writeStaticPages(storage, site, { settings }, null);
    expect(JSON.parse(storage.files.get("assets/site-banner.json") as string)).toEqual({
      visible: true,
      style: "emergency",
      message: "Evacuation order",
      links: [{ text: "Details", url: "/alerts" }],
      dismissible: false,
      startsAt: "2026-11-02T09:00:00-08:00",
      endsAt: null,
    });
  });
});

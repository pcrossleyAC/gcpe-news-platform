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
  it("robots.txt: a test site disallows everything; production names the sitemap", () => {
    expect(renderRobots(site, true)).toBe("User-agent: *\nDisallow: /\n");
    expect(renderRobots({ ...site, baseUrl: "https://news.example/site" }, false)).toBe("User-agent: *\nAllow: /\nSitemap: https://news.example/site/sitemap.xml\n");
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

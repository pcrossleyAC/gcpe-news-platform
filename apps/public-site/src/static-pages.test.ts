import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { expectAccessibleStructure } from "../test/structure";
import { memoryStorage } from "../test/memory-storage";
import { logoFor, renderNotFoundPage, renderRobots, writeStaticPages } from "./static-pages";
import { DEFAULT_THEME } from "./theme-css";

const site = { name: "BC Gov News", baseUrl: "https://news.example", theme: DEFAULT_THEME };

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
    expect([...storage.files.keys()].sort()).toEqual(["404.html", "assets/img/a.png", "assets/logo.svg", "assets/theme.css", "robots.txt"]);
    expect(storage.files.get("assets/img/a.png")).toBeInstanceOf(Uint8Array);
  });
  it("a missing assets folder is not an error", async () => {
    const storage = memoryStorage();
    await writeStaticPages(storage, site, {}, "/nonexistent/folder");
    expect(storage.files.has("assets/theme.css")).toBe(true);
  });
  it("logoFor: the logo only when the file exists under the assets folder", async () => {
    const dir = await mkdtemp(join(tmpdir(), "site-assets-"));
    const theme = { ...DEFAULT_THEME, logo: { path: "assets/logo.svg", alt: "Example" } };
    expect(logoFor(theme, dir, { baseUrl: "https://x.example/site" })).toBeNull();
    await mkdir(join(dir, "assets"));
    await writeFile(join(dir, "assets", "logo.svg"), "<svg/>");
    expect(logoFor(theme, dir, { baseUrl: "https://x.example/site" })).toEqual({ src: "/site/assets/logo.svg", alt: "Example" });
    expect(logoFor(theme, null, { baseUrl: "https://x.example/site" })).toBeNull();
  });
});

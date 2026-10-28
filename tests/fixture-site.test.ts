import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildFixtureSite, FIXTURE_PAGES, serveStatic } from "../scripts/fixture-site";

const fileOf = (path: string) => (path.endsWith("/") ? `${path}index.html` : path).replace(/^\//, "");

describe("the fixture site (6e exit checks)", () => {
  it.each([false, true])("builds every page type with the real builder (test site: %s)", async (test) => {
    const dir = await mkdtemp(join(tmpdir(), "fixture-site-"));
    try {
      await buildFixtureSite(dir, { baseUrl: "http://127.0.0.1:1", test });
      for (const path of FIXTURE_PAGES) {
        const html = await readFile(join(dir, fileOf(path)), "utf8");
        expect(html, path).toContain("<main");
        expect(html.includes('content="noindex, nofollow"'), path).toBe(test);
        // BC's tenant settings: the land acknowledgement band and footer, checked by axe and Lighthouse too.
        expect(html, path).toContain('<aside id="landAcknowledgement"');
        expect(html, path).toContain('<footer id="footer"');
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("the first release shows every release-page block: backgrounders, French, assets, translations, byline", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fixture-site-"));
    try {
      await buildFixtureSite(dir, { baseUrl: "http://127.0.0.1:1", test: false });
      const html = await readFile(join(dir, fileOf(FIXTURE_PAGES[1]!)), "utf8");
      expect(FIXTURE_PAGES[1]).toMatch(/^\/releases\//);
      expect(html.match(/class="backgrounder"/g)).toHaveLength(2);
      expect(html).toContain('data-story-lang="secondary"');
      expect(html).toContain('id="assets"');
      expect(html).toContain('id="translations"');
      expect(html).toContain('hreflang="zh-Hans"');
      expect(html).toContain('class="story-lang primary byline"');
      expect(html).toContain('<p class="story-ministry">');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("the ministry pages show the plan-2 blocks: minister card, Media Contacts, a minister of state; the Premier's Meet the Team", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fixture-site-"));
    try {
      await buildFixtureSite(dir, { baseUrl: "http://127.0.0.1:1", test: false });
      const health = await readFile(join(dir, "ministries/health/index.html"), "utf8");
      expect(health).toContain('<h1 class="ministry-name-mobile">Health</h1>');
      expect(health.match(/class="resource-links minister"/g)).toHaveLength(2);
      expect(health).toContain("<h2>Media Contacts</h2>");
      expect(health).toContain('<h2><a href="/ministries/trade/">Minister of State for Trade</a></h2>');
      const premier = await readFile(join(dir, "ministries/office-of-the-premier/index.html"), "utf8");
      expect(premier).toContain("<h2>Meet the Team</h2>");
      expect(premier).toContain("<h2>More from the Premier</h2>");
      expect(premier).toContain('<div class="top-article">');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("serves directory pages, files and a 404", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fixture-site-"));
    const server = await serveStatic(dir);
    try {
      await buildFixtureSite(dir, { baseUrl: server.url, test: false });
      expect((await fetch(`${server.url}/ministries/`)).status).toBe(200);
      expect((await fetch(`${server.url}/assets/theme.css`)).headers.get("content-type")).toBe("text/css; charset=utf-8");
      expect((await fetch(`${server.url}/no/such/page/`)).status).toBe(404);
      expect((await fetch(`${server.url}/..%2f..%2fetc/passwd`)).status).toBe(404);
      // Like production (boxs.ca's nginx), text is compressed for a client that accepts it; fonts are not.
      const css = await fetch(`${server.url}/assets/theme.css`, { headers: { "accept-encoding": "gzip" } });
      expect(css.headers.get("content-encoding")).toBe("gzip");
      expect(await css.text()).toContain(":root");
      const font = await fetch(`${server.url}/assets/legacy/fonts/BCSans-Regular.woff2`, { headers: { "accept-encoding": "gzip" } });
      expect(font.headers.get("content-encoding")).toBeNull();
      expect((await fetch(`${server.url}/assets/theme.css`, { headers: { "accept-encoding": "identity" } })).headers.get("content-encoding")).toBeNull();
    } finally {
      await server.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});

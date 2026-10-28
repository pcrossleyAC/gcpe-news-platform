import { mkdir, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { connect } from "node:net";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import express from "express";
import request from "supertest";
import { mountSite, rootSiteNotFound } from "../site-mount";
import { SITE_PASS_THROUGH } from "../stack";
import { createLegacySiteFixture } from "./fixture";

// Mirrors stack.ts (and site-mount.test.ts): mountSite, rootSiteNotFound just before News API,
// then a catch-all standing in for News API's own JSON 404.
function appFor(outputDir: string, basePath = "") {
  const app = express();
  mountSite(app, { outputDir, basePath, passThrough: ["/api", "/hub"] });
  app.use(rootSiteNotFound(outputDir, ["/api", "/hub"]));
  app.use((req, res) => void res.status(404).json({ fellThrough: true, method: req.method, path: req.path }));
  return app;
}

/** One request, no redirect following; asserts a no-store 301 to `location`. */
async function expectRedirect(app: express.Express, path: string, location: string, status = 301) {
  const res = await request(app).get(path).redirects(0);
  expect({ path, status: res.status, location: res.headers.location }).toEqual({ path, status, location });
  expect(res.headers["cache-control"]).toBe("no-store");
  return res;
}

describe("legacyUrls (fixed rules) through mountSite", () => {
  let outputDir: string;
  let app: express.Express;
  beforeEach(async () => {
    outputDir = await createLegacySiteFixture();
    app = appFor(outputDir);
  });
  afterEach(async () => {
    await rm(outputDir, { recursive: true, force: true });
  });

  // ---- one `it` per fixed-rule row ----

  it("/more-news and /{kind}/more-news|morearticles|archive|archive/{yyyy} → 301 /archive/, query dropped", async () => {
    await expectRedirect(app, "/more-news", "/archive/");
    await expectRedirect(app, "/More-News/?x=1", "/archive/");
    for (const kind of ["releases", "Stories", "factsheets"]) {
      await expectRedirect(app, `/${kind}/more-news`, "/archive/");
      await expectRedirect(app, `/${kind}/MoreArticles`, "/archive/");
      await expectRedirect(app, `/${kind}/archive`, "/archive/");
      await expectRedirect(app, `/${kind}/archive/`, "/archive/");
      await expectRedirect(app, `/${kind}/archive/2019?page=2`, "/archive/");
    }
  });

  it("/{kind}/archive/{yyyy}/{mm} → 301 /archive/{yyyy}/{mm}/ when that month page exists, else /archive/", async () => {
    await expectRedirect(app, "/releases/archive/2026/10", "/archive/2026/10/");
    await expectRedirect(app, "/factsheets/archive/2026/10/?x=1", "/archive/2026/10/");
    await expectRedirect(app, "/releases/archive/2019/01", "/archive/");
  });

  it("/archive/{yyyy} → 301 /archive/", async () => {
    await expectRedirect(app, "/archive/2026", "/archive/");
    await expectRedirect(app, "/Archive/2019/?y=1", "/archive/");
  });

  it("/{kind} (kind index, fallback) → 301 /, query dropped", async () => {
    for (const path of ["/releases", "/Stories/", "/factsheets?x=1"]) await expectRedirect(app, path, "/");
  });

  it("/sectors, /themes, /tags (fallback) → 301 /; /news-subscribe → /tags/ when it exists, else /", async () => {
    for (const path of ["/sectors", "/themes/", "/Tags", "/news-subscribe"]) await expectRedirect(app, path, "/");
    await mkdir(join(outputDir, "tags"), { recursive: true });
    await writeFile(join(outputDir, "tags", "index.html"), "<h1>tags</h1>");
    await expectRedirect(app, "/news-subscribe?x=1", "/tags/");
    // /tags itself now has a page: static wins (express.static's own trailing-slash 301).
    await expectRedirect(app, "/tags", "/tags/");
    expect((await request(app).get("/tags/")).status).toBe(200);
  });

  it("/sitemap/html → 301 /archive/", async () => {
    await expectRedirect(app, "/sitemap/html?count=5", "/archive/");
    await expectRedirect(app, "/SiteMap/HTML/", "/archive/");
  });

  it("/contact → 301 https://forms.gov.bc.ca/ (no basePath), query dropped", async () => {
    await expectRedirect(app, "/contact?x=1", "https://forms.gov.bc.ca/");
    await expectRedirect(appFor(outputDir, "/site"), "/site/Contact", "https://forms.gov.bc.ca/");
  });

  it("/subscribe/index → 301 /subscribe/ with the query kept byte for byte", async () => {
    await expectRedirect(app, "/subscribe/index?ministries=Health&x=A%2Bb", "/subscribe/?ministries=Health&x=A%2Bb");
    await expectRedirect(app, "/Subscribe/Index", "/subscribe/");
  });

  it("/subscribe/save, /subscribe/renew, /enewsletters/unsubscribe.aspx → 301 /subscribe/manage/, query dropped", async () => {
    await expectRedirect(app, "/subscribe/save?token=x", "/subscribe/manage/");
    await expectRedirect(app, "/Subscribe/Renew", "/subscribe/manage/");
    await expectRedirect(app, "/enewsletters/unsubscribe.aspx?dlid=1", "/subscribe/manage/");
  });

  it("/subscribe?…newsletters…, /newsletters/subscribe, /enewsletters/subscribe.aspx → 301 /subscribe/, query dropped", async () => {
    await expectRedirect(app, "/subscribe?newsletters=a-b", "/subscribe/");
    await expectRedirect(app, "/subscribe/?newsletters=", "/subscribe/");
    await expectRedirect(app, "/newsletters/subscribe", "/subscribe/");
    await expectRedirect(app, "/enewsletters/subscribe.aspx?dlid=4", "/subscribe/");
    // Without "newsletters" in the query, /subscribe is the page itself (static).
    expect((await request(app).get("/subscribe/?ministries=health")).status).toBe(200);
  });

  it("/subscribe.aspx?guid=00112233-4455-6677-8899-AABBCCDDEEFF → 301 /subscribe/manage/?token=00112233-4455-6677-8899-AABBCCDDEEFF", async () => {
    await expectRedirect(app, "/subscribe.aspx?guid=00112233-4455-6677-8899-AABBCCDDEEFF", "/subscribe/manage/?token=00112233-4455-6677-8899-AABBCCDDEEFF");
    await expectRedirect(app, "/Subscribe.aspx?x=1&GUID=abc&y=2", "/subscribe/manage/?token=abc");
    // No guid: no rule, the site 404.
    expect((await request(app).get("/subscribe.aspx").redirects(0)).status).toBe(404);
  });

  it("/newsletters and /newsletters/… → 301 /, query dropped", async () => {
    await expectRedirect(app, "/newsletters", "/");
    await expectRedirect(app, "/Newsletters/bc-groundwater-updates/2019-01?x=1", "/");
  });

  it("/rss/… → 301 /connect/, query dropped", async () => {
    await expectRedirect(app, "/rss/news-releases?x=1", "/connect/");
    await expectRedirect(app, "/RSS/a/b", "/connect/");
  });

  it("/search/?q=wild%20fire&resultspagenum=2&ministry=health → 301 /search/?q=wild%20fire&ministry=health", async () => {
    await expectRedirect(app, "/search/?q=wild%20fire&resultspagenum=2&ministry=health", "/search/?q=wild%20fire&ministry=health");
    await expectRedirect(app, "/Search?ResultsPageNum=3", "/search/");
    await expectRedirect(app, "/search?resultspagenum=2&q=x&resultspagenum=4", "/search/?q=x");
  });

  it("/search?q=x → 301 /search/?q=x (express.static keeps the query)", async () => {
    await expectRedirect(app, "/search?q=x", "/search/?q=x");
    expect((await request(app).get("/search/?q=x")).status).toBe(200);
  });

  it("/Content/Images/Gov/default-og-image-new.jpg → 200 image/jpeg, body JPEGDATA, no redirect", async () => {
    for (const path of ["/Content/Images/Gov/default-og-image-new.jpg", "/areas/newsroom/images/social/default-og-meta-image.jpg"]) {
      const res = await request(app).get(path).redirects(0).buffer(true);
      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toBe("image/jpeg");
      expect(res.headers.location).toBeUndefined();
      expect(Buffer.from(res.body as Buffer).toString()).toBe("JPEGDATA");
    }
    const site = await request(appFor(outputDir, "/site")).get("/site/content/images/gov/default-og-image-new.jpg?v=1").buffer(true);
    expect(site.status).toBe(200);
    expect(Buffer.from(site.body as Buffer).toString()).toBe("JPEGDATA");
  });

  it("the OG image rule falls through to the site 404 when the vendored file is missing", async () => {
    await rm(join(outputDir, "assets"), { recursive: true, force: true });
    const res = await request(app).get("/Content/Images/Gov/default-og-image-new.jpg").redirects(0);
    expect(res.status).toBe(404);
    expect(res.headers["content-type"]).toMatch(/^text\/html/);
  });

  // ---- behaviour ----

  it("/Releases/Archive/2026/10 → 301 /archive/2026/10/ (month page exists); /stories/archive/2026/09 → 301 /archive/", async () => {
    await expectRedirect(app, "/Releases/Archive/2026/10", "/archive/2026/10/");
    await expectRedirect(app, "/stories/archive/2026/09", "/archive/");
  });

  it("fallback: /releases → 301 /; after writing releases/index.html, /releases → 301 /releases/ and /releases/ → 200", async () => {
    await expectRedirect(app, "/releases", "/");
    await writeFile(join(outputDir, "releases", "index.html"), "<h1>releases</h1>");
    await expectRedirect(app, "/releases", "/releases/");
    const page = await request(app).get("/releases/");
    expect(page.status).toBe(200);
    expect(page.text).toBe("<h1>releases</h1>");
  });

  it("under basePath '/site': /site/newsletters → 301 /site/", async () => {
    const site = appFor(outputDir, "/site");
    await expectRedirect(site, "/site/newsletters", "/site/");
    await expectRedirect(site, "/site/subscribe/index?x=1", "/site/subscribe/?x=1");
    await expectRedirect(site, "/site/releases/archive/2026/10", "/site/archive/2026/10/");
  });

  it("root mount with basePath '/site' (boxs.ca today): /newsletters → 301 /", async () => {
    const site = appFor(outputDir, "/site");
    await expectRedirect(site, "/newsletters", "/");
    await expectRedirect(site, "/releases/archive/2026/10", "/archive/2026/10/");
  });

  it("POST /newsletters falls through (no redirect)", async () => {
    const res = await request(app).post("/newsletters").redirects(0);
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ fellThrough: true, method: "POST", path: "/newsletters" });
  });

  it("/api/x and /hub/X are never touched: the catch-all sees them", async () => {
    for (const path of ["/api/x", "/hub/X", "/API/newsletters", "/hub"]) {
      const res = await request(app).get(path).redirects(0);
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ fellThrough: true, method: "GET", path });
    }
  });

  // Ruling P3-R4 (review I1): the stack passes SITE_PASS_THROUGH — every stack-owned prefix but
  // /updates — so legacy GET/HEAD /updates/… URLs reach the rules and the site 404, while the
  // News API hub's POST /updates/negotiate still reaches News API.
  it("with SITE_PASS_THROUGH: GET /updates/archive → 301 /archive/, unknown /updates/x → site HTML 404, POST /updates/negotiate reaches News API", async () => {
    expect(SITE_PASS_THROUGH).not.toContain("/updates");
    expect(SITE_PASS_THROUGH).toContain("/api");
    const stackLike = express();
    mountSite(stackLike, { outputDir, basePath: "", passThrough: SITE_PASS_THROUGH });
    stackLike.use(rootSiteNotFound(outputDir, SITE_PASS_THROUGH));
    // Stands in for News API: its hub's only Express route, then its JSON catch-all.
    stackLike.post("/updates/negotiate", (_req, res) => void res.json({ negotiated: true }));
    stackLike.use((req, res) => void res.status(404).json({ fellThrough: true, method: req.method, path: req.path }));

    await expectRedirect(stackLike, "/updates/archive", "/archive/");
    await expectRedirect(stackLike, "/Updates/more-news", "/archive/");
    await expectRedirect(stackLike, "/updates", "/");
    const unknown = await request(stackLike).get("/updates/x").redirects(0);
    expect(unknown.status).toBe(404);
    expect(unknown.headers["content-type"]).toMatch(/^text\/html/);
    expect(unknown.text).toBe("<h1>site 404</h1>");
    const negotiate = await request(stackLike).post("/updates/negotiate");
    expect(negotiate.status).toBe(200);
    expect(negotiate.body).toEqual({ negotiated: true });
    // The other stack-owned prefixes are still untouched.
    const api = await request(stackLike).get("/api/x").redirects(0);
    expect(api.body).toEqual({ fellThrough: true, method: "GET", path: "/api/x" });
  });

  it("the pass-through is tested on the decoded path, the same one the rules match", async () => {
    const owned = express();
    mountSite(owned, { outputDir, basePath: "", passThrough: ["/newsletters"] });
    owned.use((req, res) => void res.status(404).json({ fellThrough: true, method: req.method, path: req.path }));
    for (const path of ["/newsletters", "/%6Eewsletters", "/%4Eewsletters/x"]) {
      const res = await request(owned).get(path).redirects(0);
      expect({ path, status: res.status, location: res.headers.location }).toEqual({ path, status: 404, location: undefined });
    }
  });

  it("/archive/{yyyy} is a fallback: once archive/2026/index.html exists, /archive/2026/ → 200 and /archive/2026 → static's 301 /archive/2026/", async () => {
    await writeFile(join(outputDir, "archive", "2026", "index.html"), "<h1>2026</h1>");
    expect((await request(app).get("/archive/2026/")).status).toBe(200);
    await expectRedirect(app, "/archive/2026", "/archive/2026/");
    await expectRedirect(app, "/archive/2019", "/archive/");
  });

  it.each(["//evil.example/newsletters", "/%2F%2Fevil.example", "/\\evil.example"])("%s never yields a Location starting with // or a host", async (path) => {
    for (const a of [app, appFor(outputDir, "/site")]) {
      const res = await request(a).get(path).redirects(0);
      const location = res.headers.location;
      if (location !== undefined) {
        expect(location.startsWith("/")).toBe(true);
        expect(location[1]).not.toBe("/");
        expect(location[1]).not.toBe("\\");
      }
      expect(res.status).toBe(404);
    }
  });

  it("an absolute-form request line never redirects off-site, and its path still matches the rules", async () => {
    const server = app.listen(0);
    try {
      const { port } = server.address() as AddressInfo;
      const raw = (target: string) =>
        new Promise<string>((resolve, reject) => {
          const sock = connect(port, "127.0.0.1", () => sock.end(`GET ${target} HTTP/1.1\r\nHost: evil.example\r\nConnection: close\r\n\r\n`));
          let out = "";
          sock.on("data", (d) => (out += d.toString()));
          sock.on("end", () => resolve(out));
          sock.on("error", reject);
        });
      const loc = (res: string) => /\r\nLocation: ([^\r]*)/i.exec(res)?.[1];
      expect(loc(await raw("http://evil.example/newsletters"))).toBe("/");
      expect(loc(await raw("http://evil.example/subscribe/index?x=a%2Bb"))).toBe("/subscribe/?x=a%2Bb");
      expect(loc(await raw("http://evil.example//evil.example/newsletters"))).toBeUndefined();
    } finally {
      server.close();
    }
  });

  it("X-Forwarded-Host: news.gov.bc.ca does not change the root-relative Location", async () => {
    const res = await request(app).get("/newsletters").set("X-Forwarded-Host", "news.gov.bc.ca").set("X-Forwarded-Proto", "https").redirects(0);
    expect(res.status).toBe(301);
    expect(res.headers.location).toBe("/");
  });

  it("HEAD /newsletters → 301 with the same Location", async () => {
    const res = await request(app).head("/newsletters").redirects(0);
    expect(res.status).toBe(301);
    expect(res.headers.location).toBe("/");
    expect(res.headers["cache-control"]).toBe("no-store");
  });

  it("a real page is never shadowed: /archive/, /subscribe/, /connect/ and a release keep answering 200", async () => {
    for (const path of ["/", "/archive/", "/archive/2026/10/", "/subscribe/", "/subscribe/manage/?token=x", "/connect/", "/releases/2026TT0105-001130/", "/feed.xml"]) {
      expect({ path, status: (await request(app).get(path).redirects(0)).status }).toEqual({ path, status: 200 });
    }
  });
});

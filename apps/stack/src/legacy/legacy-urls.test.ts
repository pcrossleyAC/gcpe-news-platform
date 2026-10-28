import { mkdir, rm, utimes, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { connect } from "node:net";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import { mountSite, rootSiteNotFound } from "../site-mount";
import { SITE_PASS_THROUGH } from "../stack";
import { createLegacySiteFixture, LONG_POST_KEY } from "./fixture";
import { legacyUrls } from "./middleware";
import { LISTING_MIN_REREAD_MS } from "./site-files";

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

describe("legacyUrls: posts by key and case-insensitive paths (url-compat T2)", () => {
  let outputDir: string;
  let app: express.Express;
  beforeEach(async () => {
    outputDir = await createLegacySiteFixture();
    app = appFor(outputDir);
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(outputDir, { recursive: true, force: true });
  });

  /** Asserts the Location answers 200 (one hop). */
  async function expectOneHop(a: express.Express, path: string, location: string) {
    await expectRedirect(a, path, location);
    expect({ location, status: (await request(a).get(location).redirects(0)).status }).toEqual({ location, status: 200 });
  }

  it("/Releases/2026tt0105-001130 → 301 /releases/2026TT0105-001130/", async () => {
    await expectOneHop(app, "/Releases/2026tt0105-001130", "/releases/2026TT0105-001130/");
    await expectOneHop(app, "/RELEASES/2026tt0105-001130/?x=A%2Bb", "/releases/2026TT0105-001130/?x=A%2Bb");
    // HEAD answers the same.
    const head = await request(app).head("/Releases/2026tt0105-001130").redirects(0);
    expect({ status: head.status, location: head.headers.location }).toEqual({ status: 301, location: "/releases/2026TT0105-001130/" });
  });

  it("/stories/2026TT0105-001130, /factsheets/…/ and /UPDATES/… → 301 /releases/2026TT0105-001130/ (one hop: the target answers 200)", async () => {
    await expectOneHop(app, "/stories/2026TT0105-001130", "/releases/2026TT0105-001130/");
    await expectOneHop(app, "/factsheets/2026tt0105-001130/", "/releases/2026TT0105-001130/");
    await expectOneHop(app, "/UPDATES/2026TT0105-001130?utm=1", "/releases/2026TT0105-001130/?utm=1");
    await expectOneHop(app, "/releases/2026TT0105-001130", "/releases/2026TT0105-001130/");
    // Through the stack's own pass-through list, /updates/<key> reaches the rule too.
    const stackLike = express();
    mountSite(stackLike, { outputDir, basePath: "", passThrough: SITE_PASS_THROUGH });
    await expectRedirect(stackLike, "/updates/2026TT0105-001130", "/releases/2026TT0105-001130/");
  });

  it("/releases/2026TT0105-001130/ → 200, no redirect", async () => {
    const res = await request(app).get("/releases/2026TT0105-001130/").redirects(0);
    expect(res.status).toBe(200);
    expect(res.text).toBe("<h1>releases/2026TT0105-001130/</h1>");
  });

  it("/releases/NOPE-1 and /stories/NOPE-1 → 404 with the site 404 body", async () => {
    for (const path of ["/releases/NOPE-1", "/stories/NOPE-1", "/Stories/NOPE-1/image", "/releases/_long", "/releases/a.b"]) {
      const res = await request(app).get(path).redirects(0);
      expect({ path, status: res.status, location: res.headers.location, body: res.text }).toEqual({ path, status: 404, location: undefined, body: "<h1>site 404</h1>" });
    }
  });

  it("/releases/2026TT0105-001130/image → 302 /assets/legacy/Content/Images/Gov/default-og-image-new.jpg", async () => {
    const og = "/assets/legacy/Content/Images/Gov/default-og-image-new.jpg";
    await expectRedirect(app, "/releases/2026TT0105-001130/image", og, 302);
    await expectRedirect(app, "/Stories/2026tt0105-001130/Image?w=1", og, 302);
    expect((await request(app).get(og).redirects(0)).status).toBe(200);
    await expectRedirect(appFor(outputDir, "/site"), "/site/factsheets/2026TT0105-001130/image", `/site${og}`, 302);
  });

  it("/Search?q=Wild%20Fire → 301 /search/?q=Wild%20Fire", async () => {
    await expectOneHop(app, "/Search?q=Wild%20Fire", "/search/?q=Wild%20Fire");
    await expectOneHop(app, "/SEARCH/?q=Wild%20Fire", "/search/?q=Wild%20Fire");
  });

  it("/Ministries/Health → 301 /ministries/health/", async () => {
    await expectOneHop(app, "/Ministries/Health", "/ministries/health/");
    await expectOneHop(app, "/Ministries/Health/", "/ministries/health/");
    await expectOneHop(app, "/Archive/2026/10", "/archive/2026/10/");
    // No lowercase page: no redirect, the site 404.
    const res = await request(app).get("/Ministries/Nope").redirects(0);
    expect({ status: res.status, location: res.headers.location }).toEqual({ status: 404, location: undefined });
  });

  it("/assets/legacy/Content/Images/Gov/BC_Mark.svg → 200 (exact case exists, never lowercased)", async () => {
    const res = await request(app).get("/assets/legacy/Content/Images/Gov/BC_Mark.svg").redirects(0);
    expect(res.status).toBe(200);
    expect(res.headers.location).toBeUndefined();
    // A lowercase twin on disk (case-sensitive FS) or not: the exact-case file still wins.
    expect((await request(app).get("/assets/legacy/Content/Images/Gov/default-og-image-new.jpg").redirects(0)).status).toBe(200);
  });

  it("/Subscribe/Manage?token=MyIRAFVEd2aImaq7zN3u_w2 → 301 /subscribe/manage/?token=MyIRAFVEd2aImaq7zN3u_w2", async () => {
    await expectOneHop(app, "/Subscribe/Manage?token=MyIRAFVEd2aImaq7zN3u_w2", "/subscribe/manage/?token=MyIRAFVEd2aImaq7zN3u_w2");
  });

  it("a fallback rule yields to the case rule: /Releases → / until releases/index.html exists, then 301 /releases/ in one hop", async () => {
    await expectRedirect(app, "/Releases", "/");
    await writeFile(join(outputDir, "releases", "index.html"), "<h1>releases</h1>");
    await expectOneHop(app, "/Releases", "/releases/");
    await expectOneHop(app, "/Releases/", "/releases/");
  });

  it("a post directory created after the first request resolves on the next one; one whose index.html was removed no longer redirects", async () => {
    expect((await request(app).get("/stories/2026TT0106-000001").redirects(0)).status).toBe(404);
    await mkdir(join(outputDir, "releases", "2026TT0106-000001"), { recursive: true });
    await writeFile(join(outputDir, "releases", "2026TT0106-000001", "index.html"), "<h1>new</h1>");
    const later = new Date(Date.now() + 60_000);
    await utimes(join(outputDir, "releases"), later, later);
    // The listing is re-checked at most every LISTING_MIN_REREAD_MS: step the clock past it.
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now + LISTING_MIN_REREAD_MS + 1);
    await expectOneHop(app, "/stories/2026tt0106-000001", "/releases/2026TT0106-000001/");

    await rm(join(outputDir, "releases", "2026TT0105-001130", "index.html"));
    for (const path of ["/stories/2026TT0105-001130", "/Releases/2026tt0105-001130", "/releases/2026TT0105-001130/image"]) {
      const res = await request(app).get(path).redirects(0);
      expect({ path, status: res.status, location: res.headers.location }).toEqual({ path, status: 404, location: undefined });
    }
  });

  it("under basePath '/site': /site/Stories/2026TT0105-001130 → 301 /site/releases/2026TT0105-001130/", async () => {
    const site = appFor(outputDir, "/site");
    await expectOneHop(site, "/site/Stories/2026TT0105-001130", "/site/releases/2026TT0105-001130/");
    await expectOneHop(site, "/site/Ministries/Health?x=1", "/site/ministries/health/?x=1");
  });

  it("escape attempts with mixed case never leave the site or OUTPUT_DIR", async () => {
    for (const path of ["//evil.example/Releases/2026TT0105-001130", "/Releases/..%2F..%2Fetc%2Fpasswd", "/Releases/%2E%2E/%2E%2E/etc/passwd", "/%2F%2Fevil.example/Ministries", "/Ministries/Health%5C..%5C..", "/Releases/2026TT0105-001130%00"]) {
      const res = await request(app).get(path).redirects(0);
      expect({ path, status: res.status, location: res.headers.location }).toEqual({ path, status: 404, location: undefined });
    }
  });
});

describe("legacyUrls: unsafe request targets never reach the static mount", () => {
  let outputDir: string;
  beforeEach(async () => {
    outputDir = await createLegacySiteFixture();
  });
  afterEach(async () => {
    await rm(outputDir, { recursive: true, force: true });
  });

  // On Windows a decoded "\" is a path separator, so express.static would walk
  // /Ministries/Health\..\.. to a directory and 301 it. Pinned on every platform by asserting
  // the handler itself answers 404 and nothing downstream (the static mount) is ever reached.
  it.each([
    "/Ministries/Health%5C..%5C..",
    "/ministries/health%5Cindex.html",
    "/releases/2026TT0105-001130%5C..%5C..%5Carchive",
    "/Releases/..%2F..%2Fetc%2Fpasswd",
    "/archive/%2e%2e/%2e%2e/x",
    "/ministries/health%00",
    "/ministries%2Fhealth",
  ])("%s → 404 from legacyUrls, downstream never called", async (path) => {
    for (const basePath of ["", "/site"]) {
      let downstream = 0;
      const app = express();
      app.use(basePath, legacyUrls({ outputDir, basePath, passThrough: ["/api", "/hub"] }), (_req, res) => {
        downstream += 1;
        res.status(200).send("served");
      });
      const res = await request(app).get(`${basePath}${path}`).redirects(0);
      expect({ basePath, path, status: res.status, location: res.headers.location, downstream }).toEqual({ basePath, path, status: 404, location: undefined, downstream: 0 });
    }
  });

  it("an unsafe target under a pass-through prefix still reaches its own app", async () => {
    let reached = 0;
    const app = express();
    app.use(legacyUrls({ outputDir, basePath: "", passThrough: ["/api", "/hub"] }), (_req, res) => {
      reached += 1;
      res.status(200).send("api");
    });
    const res = await request(app).get("/api/x%5Cy");
    expect({ status: res.status, reached }).toEqual({ status: 200, reached: 1 });
  });
});

describe("legacyUrls: post keys over 100 characters (url-compat T3, M17)", () => {
  let outputDir: string;
  let app: express.Express;
  const LONG = LONG_POST_KEY;
  const HASHED = "<h1>releases/_long/106422386aca9cfd948a818d5a9a92f5/</h1>";
  beforeEach(async () => {
    outputDir = await createLegacySiteFixture();
    app = appFor(outputDir);
  });
  afterEach(async () => {
    await rm(outputDir, { recursive: true, force: true });
  });

  it("GET /releases/<102-char key>/ → 200 serving the hashed page", async () => {
    expect(LONG).toHaveLength(102);
    const res = await request(app).get(`/releases/${LONG}/?x=1`).redirects(0);
    expect({ status: res.status, body: res.text }).toEqual({ status: 200, body: HASHED });
    const under = await request(appFor(outputDir, "/site")).get(`/site/releases/${LONG}/`).redirects(0);
    expect({ status: under.status, body: under.text }).toEqual({ status: 200, body: HASHED });
  });

  it("/RELEASES/<KEY UPPERCASED>/ → 200 (same dir)", async () => {
    const res = await request(app).get(`/RELEASES/${LONG.toUpperCase()}/`).redirects(0);
    expect({ status: res.status, body: res.text }).toEqual({ status: 200, body: HASHED });
  });

  it("/releases/<key> → 301 /releases/<key>/", async () => {
    await expectRedirect(app, `/releases/${LONG}`, `/releases/${LONG}/`);
    await expectRedirect(app, `/Releases/${LONG.toUpperCase()}?a=b`, `/releases/${LONG.toUpperCase()}/?a=b`);
  });

  it("/stories/<key> → 301 /releases/<key>/", async () => {
    await expectRedirect(app, `/stories/${LONG}`, `/releases/${LONG}/`);
    await expectRedirect(app, `/factsheets/${LONG}/`, `/releases/${LONG}/`);
  });

  it("an unknown 150-char key → 404", async () => {
    for (const path of [`/releases/${"x".repeat(150)}/`, `/stories/${"x".repeat(150)}`, `/releases/${"x".repeat(201)}/`]) {
      const res = await request(app).get(path).redirects(0);
      expect({ path: path.length, status: res.status, location: res.headers.location, body: res.text }).toEqual({ path: path.length, status: 404, location: undefined, body: "<h1>site 404</h1>" });
    }
  });

  it("a key with unsafe characters never reaches the hashed dir", async () => {
    for (const path of [`/releases/${LONG}%5C..%5C/`, `/releases/${LONG}.x/`, `/releases/${LONG}%00/`]) {
      const res = await request(app).get(path).redirects(0);
      expect({ path, status: res.status, location: res.headers.location }).toEqual({ path, status: 404, location: undefined });
    }
  });
});

describe("legacyUrls: ministries, categories, the Premier and nested keys (T4, L4)", () => {
  let outputDir: string;
  let app: express.Express;
  beforeEach(async () => {
    outputDir = await createLegacySiteFixture();
    app = appFor(outputDir);
  });
  afterEach(async () => {
    await rm(outputDir, { recursive: true, force: true });
  });
  const status = async (path: string) => (await request(app).get(path).redirects(0)).status;

  it("/ministries/justice → 301 /ministries/attorney-general/", async () => {
    await expectRedirect(app, "/ministries/justice", "/ministries/attorney-general/");
    await expectRedirect(app, "/Ministries/JUSTICE/", "/ministries/attorney-general/");
    await expectRedirect(appFor(outputDir, "/site"), "/site/ministries/justice", "/site/ministries/attorney-general/");
  });

  it("/ministries/justice/biography → 301 /ministries/attorney-general/", async () => {
    await expectRedirect(app, "/ministries/justice/biography", "/ministries/attorney-general/");
    await expectRedirect(app, "/ministries/justice/Biography/?x=1", "/ministries/attorney-general/?x=1");
  });

  it("/ministries/environmental-assessment-office is not caught by the 'environment' rename (segment-exact) → 404", async () => {
    expect(await status("/ministries/environmental-assessment-office")).toBe(404);
    expect(await status("/ministries/environmental-assessment-office/")).toBe(404);
  });

  it("/ministries/environment → 404, no redirect (the chain ends at a key with no page; live 404 too)", async () => {
    const res = await request(app).get("/ministries/environment").redirects(0);
    expect({ status: res.status, location: res.headers.location }).toEqual({ status: 404, location: undefined });
  });

  it("/ministries/transportation-and-infrastructure/infrastructure → 301 /ministries/transportation-and-transit/ (rename then successor, one hop)", async () => {
    await expectRedirect(app, "/ministries/transportation-and-infrastructure/infrastructure", "/ministries/transportation-and-transit/");
    // A single segment with no page and no rename still takes the successor table.
    await expectRedirect(app, "/ministries/transportation-and-infrastructure", "/ministries/transportation-and-transit/");
  });

  it("/ministries/jobs-economic-recovery-and-innovation/trade?x=1 → 301 /ministries/jobs-and-economic-growth/?x=1", async () => {
    await expectRedirect(app, "/ministries/jobs-economic-recovery-and-innovation/trade?x=1", "/ministries/jobs-and-economic-growth/?x=1");
    await expectRedirect(app, "/ministries/international-trade", "/ministries/jobs-and-economic-growth/");
    await expectRedirect(app, "/ministries/education-and-child-care/child-care", "/ministries/education-and-child-care/");
  });

  it("nested: /ministries/<parent>/attorney-general → 301 /ministries/attorney-general/; its /biography → the ministry page (nested is a move)", async () => {
    // Spec order (brief Interfaces): a parent with a page, or a rename, is resolved at step 2 and the
    // child is "rest"; step 3 (nested) is for a parent that is neither. The brief's test row used
    // /ministries/health/attorney-general; see the next assertion for what that gives.
    await expectRedirect(app, "/ministries/old-parent/attorney-general", "/ministries/attorney-general/");
    await expectRedirect(app, "/ministries/old-parent/attorney-general/?x=1", "/ministries/attorney-general/?x=1");
    // A nested path is "moved": the bio rule answers the ministry page, never a biography page.
    await expectRedirect(app, "/ministries/old-parent/attorney-general/biography", "/ministries/attorney-general/");
    // A nested key with a page keeps its own sub-pages.
    await expectRedirect(app, "/ministries/old-parent/office-of-the-premier/biography", "/ministries/office-of-the-premier/");
    // A reserved word is never a nested key; the unknown parent is a 404.
    expect(await status("/ministries/old-parent/releases")).toBe(404);
    expect(await status("/ministries/old-parent/nope")).toBe(404);
    // A parent that has a page is that ministry; an unknown child goes to its page.
    await expectRedirect(app, "/ministries/health/attorney-general", "/ministries/health/");
  });

  it("/office-of-the-premier → 301 /ministries/office-of-the-premier/; /office-of-the-premier/biography → 301 /ministries/office-of-the-premier/biography/; /ministries/office-of-the-premier/ → 200", async () => {
    await expectRedirect(app, "/office-of-the-premier", "/ministries/office-of-the-premier/");
    await expectRedirect(app, "/office-of-the-premier/", "/ministries/office-of-the-premier/");
    await expectRedirect(app, "/office-of-the-premier/biography", "/ministries/office-of-the-premier/biography/");
    await expectRedirect(app, "/Office-Of-The-Premier/Biography/?x=1", "/ministries/office-of-the-premier/biography/?x=1");
    await expectRedirect(app, "/ministries/office-of-the-premier", "/ministries/office-of-the-premier/");
    const ok = await request(app).get("/ministries/office-of-the-premier/").redirects(0);
    expect({ status: ok.status, body: ok.text }).toEqual({ status: 200, body: "<h1>ministries/office-of-the-premier/</h1>" });
    expect(await status("/ministries/office-of-the-premier/biography/")).toBe(200);
    await expectRedirect(appFor(outputDir, "/site"), "/site/office-of-the-premier", "/site/ministries/office-of-the-premier/");
  });

  it("a missing biography page falls back to the ministry page", async () => {
    await expectRedirect(app, "/ministries/attorney-general/biography", "/ministries/attorney-general/");
    await expectRedirect(app, "/ministries/health/biography", "/ministries/health/biography/");
  });

  it("/ministries/health/factsheets → 301 /ministries/health/ until ministries/health/factsheets/index.html exists, then 301 /ministries/health/factsheets/", async () => {
    await expectRedirect(app, "/ministries/health/factsheets", "/ministries/health/");
    await expectRedirect(app, "/ministries/health/Factsheets/?page=2", "/ministries/health/?page=2");
    await mkdir(join(outputDir, "ministries", "health", "factsheets"), { recursive: true });
    await writeFile(join(outputDir, "ministries", "health", "factsheets", "index.html"), "<h1>fs</h1>");
    await expectRedirect(app, "/ministries/health/factsheets", "/ministries/health/factsheets/");
    expect(await status("/ministries/health/factsheets/")).toBe(200);
    await expectRedirect(app, "/ministries/justice/factsheets", "/ministries/attorney-general/");
  });

  it("/ministries/health/more-news?page=2 → 301 /ministries/health/ (query dropped)", async () => {
    await expectRedirect(app, "/ministries/health/more-news?page=2", "/ministries/health/");
    await expectRedirect(app, "/ministries/health/releases/archive/2019?page=2", "/ministries/health/");
    await expectRedirect(app, "/ministries/justice/morearticles", "/ministries/attorney-general/");
  });

  it("/news-subscribe/x → 301 /tags/x/; /sectors/families/ → 301 /sectors/services/", async () => {
    await expectRedirect(app, "/news-subscribe/x", "/tags/x/");
    await expectRedirect(app, "/News-Subscribe/X/?a=1", "/tags/x/?a=1");
    await expectRedirect(app, "/sectors/families/", "/sectors/services/");
    expect(await status("/tags/x/")).toBe(200);
    // No page: the site 404 (no redirect to a missing page).
    expect(await status("/tags/nope/")).toBe(404);
    expect(await status("/news-subscribe/nope")).toBe(404);
    expect(await status("/sectors/nope/")).toBe(404);
  });

  it("/ministries/health/ → 200 (no redirect)", async () => {
    const res = await request(app).get("/ministries/health/").redirects(0);
    expect({ status: res.status, location: res.headers.location }).toEqual({ status: 200, location: undefined });
    expect(await status("/ministries/health/biography/")).toBe(200);
    // Its feed files are served in place (describe "legacy feed URLs" below).
    expect(await status("/ministries/health/feed.xml")).toBe(200);
  });

  it("an old ministry's page still on disk redirects to its successor (the plan-2 successor behaviour, now via legacyUrls)", async () => {
    await mkdir(join(outputDir, "ministries", "transportation-and-infrastructure"), { recursive: true });
    await writeFile(join(outputDir, "ministries", "transportation-and-infrastructure", "index.html"), "<h1>old</h1>");
    await expectRedirect(app, "/ministries/transportation-and-infrastructure/", "/ministries/transportation-and-transit/");
    await expectRedirect(app, "/ministries/transportation-and-infrastructure/biography", "/ministries/transportation-and-transit/");
  });

  it("an unparseable or unsafe category path is the site 404, never a redirect", async () => {
    for (const path of ["/ministries/justice%5Cx", "/ministries/%2e%2e/justice", "/ministries/ju%00stice"]) expect(await status(path), path).toBe(404);
  });
});

describe("legacyUrls: NEWS-n short links (url-compat T5)", () => {
  let outputDir: string;
  beforeEach(async () => {
    outputDir = await createLegacySiteFixture();
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(outputDir, { recursive: true, force: true });
  });
  const KEYS: Record<string, string> = { "NEWS-34336": "2026TT0103-001121", "NEWS-7": "no-such-page-on-disk", "NEWS-8": "bad key!" };
  const lookup = async (r: string) => KEYS[r] ?? null;
  function appWith(lookupReference?: (r: string) => Promise<string | null>) {
    const app = express();
    mountSite(app, { outputDir, basePath: "", passThrough: ["/api", "/hub"], lookupReference });
    app.use(rootSiteNotFound(outputDir, ["/api", "/hub"]));
    app.use((req, res) => void res.status(404).json({ fellThrough: true }));
    return app;
  }

  it("/34336 → 301 /releases/2026TT0103-001121/", async () => {
    await expectRedirect(appWith(lookup), "/34336", "/releases/2026TT0103-001121/");
    await expectRedirect(appWith(lookup), "/34336?utm=x", "/releases/2026TT0103-001121/?utm=x");
  });

  it("/34336/ → same", async () => {
    await expectRedirect(appWith(lookup), "/34336/", "/releases/2026TT0103-001121/");
  });

  it("/99999 → 404", async () => {
    expect((await request(appWith(lookup)).get("/99999")).status).toBe(404);
  });

  it("a reference whose key has no page, or is not a valid key, → 404", async () => {
    expect((await request(appWith(lookup)).get("/7")).status).toBe(404);
    expect((await request(appWith(lookup)).get("/8")).status).toBe(404);
  });

  it("a long key resolves through its hashed dir", async () => {
    await expectRedirect(appWith(async () => LONG_POST_KEY), "/34336", `/releases/${LONG_POST_KEY}/`);
  });

  it("a throwing lookup → 404, logged once across two requests", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const app = appWith(async () => {
      throw new Error("db down");
    });
    expect((await request(app).get("/34336")).status).toBe(404);
    expect((await request(app).get("/34336")).status).toBe(404);
    expect(err.mock.calls.filter((c) => String(c[0]).includes("[stack] reference lookup failed: db down"))).toHaveLength(1);
  });

  it("/2026 with no reference → 404 (no clash with archive paths, which live under /archive/)", async () => {
    expect((await request(appWith(async () => null)).get("/2026")).status).toBe(404);
    await expectRedirect(appWith(lookup), "/archive/2026/10", "/archive/2026/10/");
  });

  it("without lookupReference the rule is off", async () => {
    expect((await request(appWith()).get("/34336")).status).toBe(404);
  });

  it("a nine-digit n is looked up; ten digits and non-numbers are not", async () => {
    const seen: string[] = [];
    const app = appWith(async (r) => (seen.push(r), null));
    await request(app).get("/123456789");
    await request(app).get("/1234567890");
    await request(app).get("/12ab");
    expect(seen).toEqual(["NEWS-123456789"]);
  });
});

const RSS = "application/rss+xml; charset=utf-8";
const ATOM = "application/atom+xml; charset=utf-8";

describe("legacyUrls: legacy feed URLs served in place (url-compat T6)", () => {
  let outputDir: string;
  let app: express.Express;
  beforeEach(async () => {
    outputDir = await createLegacySiteFixture();
    app = appFor(outputDir);
  });
  afterEach(async () => {
    await rm(outputDir, { recursive: true, force: true });
  });
  const get = (path: string) => request(app).get(path).redirects(0);
  /** Asserts a 200 in place: the content type, no Location, and a body naming `file`. */
  async function expectFeed(path: string, type: string, file: string) {
    const res = await get(path);
    expect({ path, status: res.status, type: res.headers["content-type"], location: res.headers.location }).toEqual({ path, status: 200, type, location: undefined });
    expect(res.text, path).toContain(`>${file}<`);
    return res;
  }
  const ROOT_FEED = '<?xml version="1.0"?><rss version="2.0"><channel/></rss>';

  it("/feed → 200 application/rss+xml, body = feed.xml", async () => {
    const res = await get("/feed");
    expect({ status: res.status, type: res.headers["content-type"], body: res.text }).toEqual({ status: 200, type: RSS, body: ROOT_FEED });
    expect((await get("/FEED/")).text).toBe(ROOT_FEED);
    expect((await get("/rss.xml")).text).toBe(ROOT_FEED);
  });

  it("/feed/rss → 200 (legacy answered 500)", async () => {
    const res = await get("/feed/rss");
    expect({ status: res.status, type: res.headers["content-type"], body: res.text }).toEqual({ status: 200, type: RSS, body: ROOT_FEED });
  });

  it("/feed/atom → 200 application/atom+xml", async () => {
    await expectFeed("/feed/atom", ATOM, "atom.xml");
  });

  it("/factsheets/feed and /factsheets/feed/atom → 200 from feeds/", async () => {
    await expectFeed("/factsheets/feed", RSS, "feeds/factsheets.xml");
    await expectFeed("/Factsheets/Feed/rss", RSS, "feeds/factsheets.xml");
    await expectFeed("/factsheets/feed/atom", ATOM, "feeds/factsheets.atom.xml");
    await expectFeed("/releases/feed", RSS, "feeds/releases.xml");
  });

  it("/ministries/health/releases/feed → 200 serving ministries/health/feed.xml", async () => {
    await expectFeed("/ministries/health/releases/feed", RSS, "ministries/health/feed.xml");
    await expectFeed("/ministries/health/feed", RSS, "ministries/health/feed.xml");
    await expectFeed("/ministries/health/feed/atom", ATOM, "ministries/health/atom.xml");
    await expectFeed("/Ministries/Health/Factsheets/Feed/Atom/", ATOM, "ministries/health/atom.xml");
  });

  it("/ministries/justice/feed/atom → 200 serving ministries/attorney-general/atom.xml, no redirect", async () => {
    await expectFeed("/ministries/justice/feed/atom", ATOM, "ministries/attorney-general/atom.xml");
    await expectFeed("/ministries/justice/feed", RSS, "ministries/attorney-general/feed.xml");
    await expectFeed("/ministries/old-parent/attorney-general/stories/feed", RSS, "ministries/attorney-general/feed.xml");
  });

  it("/office-of-the-premier/feed → 200 if ministries/office-of-the-premier/feed.xml exists", async () => {
    expect((await get("/office-of-the-premier/feed")).status).toBe(404);
    await writeFile(join(outputDir, "ministries", "office-of-the-premier", "feed.xml"), "<rss>premier</rss>");
    const res = await get("/office-of-the-premier/feed");
    expect({ status: res.status, type: res.headers["content-type"], body: res.text }).toEqual({ status: 200, type: RSS, body: "<rss>premier</rss>" });
    expect((await get("/office-of-the-premier/releases/feed/rss")).text).toBe("<rss>premier</rss>");
  });

  it("/top/feed and /feature/<any>[/rss|/atom] → feed.xml / atom.xml", async () => {
    expect((await get("/top/feed")).text).toBe(ROOT_FEED);
    expect((await get("/feature/anything/rss")).text).toBe(ROOT_FEED);
    expect((await get("/Top/Anything")).headers["content-type"]).toBe(RSS);
    await expectFeed("/top/anything/atom", ATOM, "atom.xml");
  });

  it("/feed?newsOnDemand=1 → 200", async () => {
    const res = await get("/feed?newsOnDemand=1");
    expect({ status: res.status, type: res.headers["content-type"] }).toEqual({ status: 200, type: RSS });
  });

  it("HEAD /feed → 200 with the RSS content type", async () => {
    for (const [path, type] of [["/feed", RSS], ["/feed/atom", ATOM], ["/ministries/justice/feed/atom", ATOM], ["/feed.xml", RSS], ["/atom.xml", ATOM]] as const) {
      const res = await request(app).head(path).redirects(0);
      expect({ path, status: res.status, type: res.headers["content-type"], text: res.text }).toEqual({ path, status: 200, type, text: undefined });
    }
  });

  it("/ministries/nope/feed → 404", async () => {
    for (const path of ["/ministries/nope/feed", "/ministries/nope/feed/atom", "/tags/nope/feed", "/updates/feed"]) {
      expect((await get(path)).status, path).toBe(404);
    }
  });

  it("a feed path is the base-path-mounted site's too (/site/feed)", async () => {
    const res = await request(appFor(outputDir, "/site")).get("/site/ministries/justice/feed/atom").redirects(0);
    expect({ status: res.status, type: res.headers["content-type"] }).toEqual({ status: 200, type: ATOM });
  });

  // ---- carried findings (Task 5 review) ----

  it("/ministries/health/atom.xml and /releases/embed are not swallowed by the category rule", async () => {
    await expectFeed("/ministries/health/atom.xml", ATOM, "ministries/health/atom.xml");
    const embed = await get("/ministries/health/releases/embed");
    expect({ status: embed.status, location: embed.headers.location }).toEqual({ status: 404, location: undefined });
    expect((await get("/ministries/health/embed")).status).toBe(404);
  });

  it("/ministries/health/top/releases is not a feed: it is a sub-path of the category, 301 to its page", async () => {
    await expectRedirect(app, "/ministries/health/top/releases", "/ministries/health/");
  });

  it("an old ministry's feed.xml / atom.xml serve the successor's file, not the stale one", async () => {
    await mkdir(join(outputDir, "ministries", "transportation-and-infrastructure"), { recursive: true });
    await writeFile(join(outputDir, "ministries", "transportation-and-infrastructure", "feed.xml"), "<rss>STALE</rss>");
    await writeFile(join(outputDir, "ministries", "transportation-and-infrastructure", "atom.xml"), "<feed>STALE</feed>");
    await mkdir(join(outputDir, "ministries", "transportation-and-transit"), { recursive: true });
    await writeFile(join(outputDir, "ministries", "transportation-and-transit", "feed.xml"), "<rss>SUCCESSOR</rss>");
    await writeFile(join(outputDir, "ministries", "transportation-and-transit", "atom.xml"), "<feed>SUCCESSOR</feed>");
    for (const [path, type, body] of [
      ["/ministries/transportation-and-infrastructure/feed.xml", RSS, "<rss>SUCCESSOR</rss>"],
      ["/ministries/transportation-and-infrastructure/atom.xml", ATOM, "<feed>SUCCESSOR</feed>"],
      ["/ministries/transportation-and-infrastructure/feed", RSS, "<rss>SUCCESSOR</rss>"],
      ["/ministries/justice/feed.xml", RSS, '<?xml version="1.0"?><feed>ministries/attorney-general/feed.xml</feed>'],
    ] as const) {
      const res = await get(path);
      expect({ path, status: res.status, type: res.headers["content-type"], body: res.text }).toEqual({ path, status: 200, type, body });
    }
    // A moved key whose successor has no feed file is a 404, never the stale file.
    await rm(join(outputDir, "ministries", "transportation-and-transit", "feed.xml"));
    expect((await get("/ministries/transportation-and-infrastructure/feed.xml")).status).toBe(404);
  });

  it("direct requests for feed files carry the legacy content types", async () => {
    for (const [path, type] of [
      ["/feed.xml", RSS],
      ["/atom.xml", ATOM],
      ["/feeds/releases.xml", RSS],
      ["/feeds/releases.atom.xml", ATOM],
      ["/feeds/factsheets.xml", RSS],
      ["/ministries/health/feed.xml", RSS],
      ["/ministries/health/atom.xml", ATOM],
    ] as const) {
      const res = await get(path);
      expect({ path, status: res.status, type: res.headers["content-type"] }).toEqual({ path, status: 200, type });
    }
  });
});

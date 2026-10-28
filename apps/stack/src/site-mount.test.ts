import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import express from "express";
import request from "supertest";
import { mountSite, rootSiteNotFound, siteBasePath } from "./site-mount";

// Mirrors stack.ts: mountSite where the /site mount used to be, rootSiteNotFound just before
// News API, then a catch-all that stands in for News API's own JSON 404.
function appFor(outputDir: string, basePath: string) {
  const app = express();
  mountSite(app, { outputDir, basePath });
  app.use(rootSiteNotFound(outputDir, ["/api", "/health", "/updates"]));
  app.use((req, res) => void res.status(404).json({ fellThrough: true, method: req.method, path: req.path }));
  return app;
}

describe("mountSite / siteAliasRedirect / rootSiteNotFound", () => {
  let outputDir: string;
  beforeEach(async () => {
    outputDir = await mkdtemp(join(tmpdir(), "gcpe-site-mount-"));
    await writeFile(join(outputDir, "index.html"), "<h1>home</h1>");
    await mkdir(join(outputDir, "releases", "k"), { recursive: true });
    await writeFile(join(outputDir, "releases", "k", "index.html"), "<h1>release k</h1>");
    await writeFile(join(outputDir, "404.html"), "<h1>site 404</h1>");
    await writeFile(join(outputDir, ".site-state.json"), '{"granvilleOn":true}');
  });
  afterEach(async () => {
    await rm(outputDir, { recursive: true, force: true });
  });

  it("base '' — GET / serves index.html; /releases/k/ serves the page; /releases/k → 301 /releases/k/ with no-store", async () => {
    const app = appFor(outputDir, "");
    const home = await request(app).get("/");
    expect(home.status).toBe(200);
    expect(home.text).toBe("<h1>home</h1>");
    expect(home.headers["cache-control"]).toBe("public, max-age=60");
    const page = await request(app).get("/releases/k/");
    expect(page.status).toBe(200);
    expect(page.text).toBe("<h1>release k</h1>");
    const dir = await request(app).get("/releases/k").redirects(0);
    expect(dir.status).toBe(301);
    expect(dir.headers.location).toBe("/releases/k/");
    expect(dir.headers["cache-control"]).toBe("no-store");
  });

  it("base '' — /site/subscribe/manage/?token=a%2Bb → 301 Location '/subscribe/manage/?token=a%2Bb', one hop, no-store", async () => {
    const app = appFor(outputDir, "");
    const res = await request(app).get("/site/subscribe/manage/?token=a%2Bb").redirects(0);
    expect(res.status).toBe(301);
    expect(res.headers.location).toBe("/subscribe/manage/?token=a%2Bb");
    expect(res.headers["cache-control"]).toBe("no-store");
    // One hop: the target of a release redirect is served directly, not redirected again.
    const hop = await request(app).get("/site/releases/k/").redirects(0);
    expect(hop.headers.location).toBe("/releases/k/");
    expect((await request(app).get(hop.headers.location!).redirects(0)).status).toBe(200);
  });

  it("base '' — /site and /site/ → 301 '/'", async () => {
    const app = appFor(outputDir, "");
    for (const path of ["/site", "/site/"]) {
      const res = await request(app).get(path).redirects(0);
      expect(res.status).toBe(301);
      expect(res.headers.location).toBe("/");
      expect(res.headers["cache-control"]).toBe("no-store");
    }
    const q = await request(app).get("/site?x=1").redirects(0);
    expect(q.headers.location).toBe("/?x=1");
    const head = await request(app).head("/site/releases/k/").redirects(0);
    expect(head.status).toBe(301);
    expect(head.headers.location).toBe("/releases/k/");
  });

  it("base '' — a /site// or /site/\\ URL never redirects off-site: it is the site 404, as at the root", async () => {
    const app = appFor(outputDir, "");
    for (const path of ["/site//evil.example/x", "/site/%5Cevil.example", "/site/\\evil.example"]) {
      const res = await request(app).get(path).redirects(0);
      expect({ path, status: res.status, location: res.headers.location }).toEqual({ path, status: 404, location: undefined });
    }
  });

  // Review T2 minor 1: an absolute-form request line (proxies may send one) used to give a
  // Location built from originalUrl's length ("/evil.example/site/x"); it is the remainder now.
  it("base '' — an absolute-form request line redirects to the path remainder, query intact", async () => {
    const server = appFor(outputDir, "").listen(0);
    try {
      const { port } = server.address() as import("node:net").AddressInfo;
      const raw = async (target: string) => {
        const { connect } = await import("node:net");
        return new Promise<string>((resolve, reject) => {
          const sock = connect(port, "127.0.0.1", () => sock.end(`GET ${target} HTTP/1.1\r\nHost: evil.example\r\nConnection: close\r\n\r\n`));
          let out = "";
          sock.on("data", (d) => (out += d.toString()));
          sock.on("end", () => resolve(out));
          sock.on("error", reject);
        });
      };
      const loc = (res: string) => /\r\nLocation: ([^\r]*)/i.exec(res)?.[1];
      expect(loc(await raw("http://evil.example/site/x?q=a%2Bb"))).toBe("/x?q=a%2Bb");
      // "//x" is an unsafe target (legacyUrls runs on the remainder): the site 404, no Location.
      expect(loc(await raw("https://evil.example/site//x"))).toBeUndefined();
      expect(loc(await raw("http://evil.example/site"))).toBe("/");
      expect(loc(await raw("/site/x?q=1"))).toBe("/x?q=1");
    } finally {
      server.close();
    }
  });

  it("base '' — POST /site/x falls through (next)", async () => {
    const app = appFor(outputDir, "");
    const res = await request(app).post("/site/x").redirects(0);
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ fellThrough: true, method: "POST", path: "/site/x" });
  });

  it("base '' — /sitemap.xml and /site-builder are not /site and are not redirected", async () => {
    await writeFile(join(outputDir, "sitemap.xml"), "<urlset/>");
    const app = appFor(outputDir, "");
    const sitemap = await request(app).get("/sitemap.xml").redirects(0);
    expect(sitemap.status).toBe(200);
    expect(sitemap.text).toBe("<urlset/>");
    expect((await request(app).get("/site-builder/x").redirects(0)).status).toBe(404);
  });

  it("base '/site' — /site/ serves index.html and / serves it too; /site/x is not redirected", async () => {
    const app = appFor(outputDir, "/site");
    const prefixed = await request(app).get("/site/").redirects(0);
    expect(prefixed.status).toBe(200);
    expect(prefixed.text).toBe("<h1>home</h1>");
    expect(prefixed.headers["cache-control"]).toBe("public, max-age=60");
    const root = await request(app).get("/").redirects(0);
    expect(root.status).toBe(200);
    expect(root.text).toBe("<h1>home</h1>");
    expect((await request(app).get("/site/releases/k/").redirects(0)).text).toBe("<h1>release k</h1>");
    const missing = await request(app).get("/site/x").redirects(0);
    expect(missing.status).toBe(404);
    expect(missing.headers.location).toBeUndefined();
    expect(missing.text).toBe("<h1>site 404</h1>");
    const dir = await request(app).get("/site/releases/k").redirects(0);
    expect(dir.status).toBe(301);
    expect(dir.headers.location).toBe("/site/releases/k/");
    expect(dir.headers["cache-control"]).toBe("no-store");
  });

  it("/.site-state.json is refused at the root and under /site", async () => {
    for (const [base, path] of [
      ["", "/.site-state.json"],
      ["/site", "/.site-state.json"],
      ["/site", "/site/.site-state.json"],
    ] as const) {
      const res = await request(appFor(outputDir, base)).get(path).redirects(0);
      expect(res.status).not.toBe(200);
      expect(res.text).not.toContain("granvilleOn");
    }
    // With base '', /site/.site-state.json redirects to the root path, which is refused too.
    const alias = await request(appFor(outputDir, "")).get("/site/.site-state.json").redirects(0);
    expect(alias.status).toBe(301);
    const target = await request(appFor(outputDir, "")).get(alias.headers.location!).redirects(0);
    expect(target.status).toBe(404);
    expect(target.text).not.toContain("granvilleOn");
  });

  it("rootSiteNotFound — GET /no-such/ → 404 text/html 404.html; GET /api/v2/x and /health/nope and /updates/x call next()", async () => {
    const app = appFor(outputDir, "");
    const res = await request(app).get("/no-such/");
    expect(res.status).toBe(404);
    expect(res.headers["content-type"]).toMatch(/^text\/html/);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.text).toBe("<h1>site 404</h1>");
    for (const path of ["/api/v2/x", "/health/nope", "/updates/x", "/api", "/health"]) {
      const passed = await request(app).get(path);
      expect(passed.status).toBe(404);
      expect(passed.body).toEqual({ fellThrough: true, method: "GET", path });
    }
    // Express mounts match case-insensitively, so a legacy /API/Posts still reaches News API.
    expect((await request(app).get("/API/Posts")).body).toEqual({ fellThrough: true, method: "GET", path: "/API/Posts" });
    // A prefix only passes through on a segment boundary: /apiary is a site URL.
    expect((await request(app).get("/apiary")).text).toBe("<h1>site 404</h1>");
    // Non-GET/HEAD still falls through, as siteNotFound does.
    expect((await request(app).post("/no-such/")).body).toEqual({ fellThrough: true, method: "POST", path: "/no-such/" });
  });

  it("siteBasePath — the PUBLIC_SITE_URL's path with trailing slashes stripped", () => {
    expect(siteBasePath("https://boxs.ca/site")).toBe("/site");
    expect(siteBasePath("https://boxs.ca/site/")).toBe("/site");
    expect(siteBasePath("https://boxs.ca")).toBe("");
    expect(siteBasePath("https://boxs.ca/")).toBe("");
    expect(siteBasePath("self:/site")).toBe("/site");
  });
});

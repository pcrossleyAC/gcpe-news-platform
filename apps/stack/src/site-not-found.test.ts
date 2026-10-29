import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import express from "express";
import request from "supertest";
import { siteNotFound } from "./site-not-found";

// Mirrors stack.ts: the static mount, then this fallback on the same prefix, then an app that
// owns "/" with a JSON catch-all (News API's).
function appFor(outputDir: string) {
  const app = express();
  app.use("/site", express.static(outputDir, { index: "index.html", dotfiles: "deny" }), siteNotFound(outputDir));
  app.use((_req, res) => void res.status(404).json({ error: "not found" }));
  return app;
}

describe("siteNotFound", () => {
  let outputDir: string;
  beforeEach(async () => {
    outputDir = await mkdtemp(join(tmpdir(), "gcpe-site-404-"));
  });
  afterEach(async () => {
    await rm(outputDir, { recursive: true, force: true });
  });

  it("an unknown page under the site answers 404 with the site's own 404.html", async () => {
    await writeFile(join(outputDir, "404.html"), "<h1>Page not found</h1>");
    const res = await request(appFor(outputDir)).get("/site/no-such-page-xyz/");
    expect(res.status).toBe(404);
    expect(res.headers["content-type"]).toMatch(/^text\/html/);
    expect(res.text).toBe("<h1>Page not found</h1>");
    expect(res.headers["cache-control"]).toBe("no-store");
  });

  it("HEAD gets the same 404 status and type, no body", async () => {
    await writeFile(join(outputDir, "404.html"), "<h1>Page not found</h1>");
    const res = await request(appFor(outputDir)).head("/site/missing.html");
    expect(res.status).toBe(404);
    expect(res.headers["content-type"]).toMatch(/^text\/html/);
    expect(res.text ?? "").toBe("");
  });

  it("before 404.html has been written (cold start) answers a minimal HTML 404, never JSON", async () => {
    const res = await request(appFor(outputDir)).get("/site/no-such-page-xyz/");
    expect(res.status).toBe(404);
    expect(res.headers["content-type"]).toMatch(/^text\/html/);
    expect(res.text).toContain("Page not found");
    expect(res.text).not.toContain('"error"');
  });

  it("a dotfile under the site is the 404 page, not its contents", async () => {
    await writeFile(join(outputDir, "404.html"), "<h1>Page not found</h1>");
    await writeFile(join(outputDir, ".site-state.json"), '{"granvilleOn":true}');
    const res = await request(appFor(outputDir)).get("/site/.site-state.json");
    expect(res.status).toBe(404);
    expect(res.text).not.toContain("granvilleOn");
  });

  it("a Range or conditional request still gets the whole 404 page with status 404 (no 206, no 304, no validators)", async () => {
    await writeFile(join(outputDir, "404.html"), "<h1>Page not found</h1>");
    const app = appFor(outputDir);
    const ranged = await request(app).get("/site/missing.html").set("range", "bytes=0-3");
    expect(ranged.status).toBe(404);
    expect(ranged.text).toBe("<h1>Page not found</h1>");
    expect(ranged.headers["content-range"]).toBeUndefined();
    expect(ranged.headers["accept-ranges"]).toBeUndefined();
    expect(ranged.headers["etag"]).toBeUndefined();
    expect(ranged.headers["last-modified"]).toBeUndefined();
    const conditional = await request(app).get("/site/missing.html").set("if-modified-since", new Date(Date.now() + 86_400_000).toUTCString());
    expect(conditional.status).toBe(404);
    expect(conditional.text).toBe("<h1>Page not found</h1>");
  });

  it("an existing page is still served by the static mount", async () => {
    await writeFile(join(outputDir, "index.html"), "<p>home</p>");
    const res = await request(appFor(outputDir)).get("/site/");
    expect(res.status).toBe(200);
    expect(res.text).toBe("<p>home</p>");
  });

  it("non-GET/HEAD under the site, and paths outside it, keep the JSON 404", async () => {
    const app = appFor(outputDir);
    const post = await request(app).post("/site/whatever");
    expect(post.status).toBe(404);
    expect(post.body).toEqual({ error: "not found" });
    const api = await request(app).get("/api/no-such-thing");
    expect(api.status).toBe(404);
    expect(api.body).toEqual({ error: "not found" });
    const sibling = await request(app).get("/site-builder/nope");
    expect(sibling.body).toEqual({ error: "not found" });
  });
});

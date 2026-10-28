import { chmod, mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import { ministrySuccessorRedirects, resolveMinistrySuccessor } from "./ministry-successors";
import { mountSite } from "./site-mount";

describe("ministrySuccessorRedirects", () => {
  let outputDir: string;
  const file = () => join(outputDir, "legacy", "ministry-successors.json");
  const writeTable = async (successors: Record<string, string>, mtime?: Date) => {
    await mkdir(join(outputDir, "legacy"), { recursive: true });
    await writeFile(file(), JSON.stringify({ successors }));
    if (mtime) await utimes(file(), mtime, mtime);
  };
  const appFor = (basePath = "") => {
    const app = express();
    app.use(ministrySuccessorRedirects(outputDir, basePath));
    app.use((req, res) => void res.status(404).json({ fellThrough: true, path: req.path }));
    return app;
  };
  const get = (app: express.Express, path: string) => request(app).get(path).redirects(0);

  beforeEach(async () => {
    outputDir = await mkdtemp(join(tmpdir(), "gcpe-ministry-successors-"));
  });
  afterEach(async () => {
    await rm(outputDir, { recursive: true, force: true });
  });

  it("/ministries/a/ → 301 /ministries/c/, no-store", async () => {
    await writeTable({ a: "c" });
    const res = await get(appFor(), "/ministries/a/");
    expect(res.status).toBe(301);
    expect(res.headers.location).toBe("/ministries/c/");
    expect(res.headers["cache-control"]).toBe("no-store");
  });

  it("keeps the rest of the path and the query, byte for byte", async () => {
    await writeTable({ a: "c" });
    expect((await get(appFor(), "/ministries/a/feed.xml?x=1")).headers.location).toBe("/ministries/c/feed.xml?x=1");
    expect((await get(appFor(), "/ministries/a/feed.xml?t=a%2Bb&y")).headers.location).toBe("/ministries/c/feed.xml?t=a%2Bb&y");
    expect((await get(appFor(), "/ministries/a?x=1")).headers.location).toBe("/ministries/c/?x=1");
  });

  it("matches whole segments only, case-insensitively", async () => {
    await writeTable({ a: "c" });
    expect((await get(appFor(), "/ministries/ab/")).status).toBe(404);
    expect((await get(appFor(), "/ministries/")).status).toBe(404);
    expect((await get(appFor(), "/ministriesa/")).status).toBe(404);
    expect((await get(appFor(), "/x/ministries/a/")).status).toBe(404);
    const upper = await get(appFor(), "/ministries/A");
    expect(upper.status).toBe(301);
    expect(upper.headers.location).toBe("/ministries/c/");
    expect((await get(appFor(), "/MINISTRIES/A/feed.xml")).headers.location).toBe("/ministries/c/feed.xml");
  });

  it("carries the mount's base path", async () => {
    await writeTable({ a: "c" });
    const app = express();
    app.use("/site", ministrySuccessorRedirects(outputDir, "/site"));
    expect((await get(app, "/site/ministries/a/feed.xml?x=1")).headers.location).toBe("/site/ministries/c/feed.xml?x=1");
  });

  it("never leaves the site", async () => {
    await writeTable({ a: "c" });
    for (const path of ["/ministries/a//evil.example/", "/ministries/a/%2F%2Fevil.example", "/ministries/a/\\evil.example"]) {
      const loc = (await get(appFor(), path)).headers.location!;
      expect(loc.startsWith("/ministries/c/"), `${path} → ${loc}`).toBe(true);
    }
    // An absolute-form request line still answers with a path, not the client's host.
    const app = appFor();
    const server = app.listen(0);
    try {
      const { port } = server.address() as { port: number };
      const res = await new Promise<{ status: number; location: string | undefined }>((resolve, reject) => {
        const req = httpRequest({ host: "127.0.0.1", port, path: "http://evil.example/ministries/a/x?q=1" }, (r: IncomingMessage) => {
          r.resume();
          resolve({ status: r.statusCode!, location: r.headers.location });
        });
        req.on("error", reject);
        req.end();
      });
      expect(res).toEqual({ status: 301, location: "/ministries/c/x?q=1" });
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)("an unreadable file passes through and is logged once, not per request", async () => {
    await writeTable({ a: "c" });
    await chmod(join(outputDir, "legacy"), 0o000);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      for (let i = 0; i < 3; i++) expect((await get(appFor(), "/ministries/a/")).status).toBe(404);
      expect(warn.mock.calls.filter(([m]) => String(m).includes("unreadable"))).toEqual([["[stack] ministry successors unreadable: EACCES"]]);
    } finally {
      warn.mockRestore();
      await chmod(join(outputDir, "legacy"), 0o755);
    }
    expect((await get(appFor(), "/ministries/a/")).status).toBe(301);
  });

  it("a table entry that isn't two lowercased category keys is ignored", async () => {
    await writeTable({ a: "//evil.example", b: "c/../d", e: "e", F: "c", g: "c" });
    for (const k of ["a", "b", "e", "f"]) expect((await get(appFor(), `/ministries/${k}/`)).status, k).toBe(404);
    expect((await get(appFor(), "/ministries/g/")).headers.location).toBe("/ministries/c/");
  });

  it("GET and HEAD only", async () => {
    await writeTable({ a: "c" });
    expect((await request(appFor()).head("/ministries/a/").redirects(0)).status).toBe(301);
    expect((await request(appFor()).post("/ministries/a/").redirects(0)).status).toBe(404);
  });

  it("a missing or malformed file passes through", async () => {
    expect((await get(appFor(), "/ministries/a/")).status).toBe(404);
    await mkdir(join(outputDir, "legacy"), { recursive: true });
    await writeFile(file(), "{not json");
    expect((await get(appFor(), "/ministries/a/")).status).toBe(404);
  });

  it("an updated file is picked up; a deleted one stops the redirects", async () => {
    const app = appFor();
    await writeTable({ a: "c" }, new Date("2026-10-28T10:00:00Z"));
    expect((await get(app, "/ministries/a/")).headers.location).toBe("/ministries/c/");
    await writeTable({ a: "d", b: "d" }, new Date("2026-10-28T10:00:05Z"));
    expect((await get(app, "/ministries/a/")).headers.location).toBe("/ministries/d/");
    expect((await get(app, "/ministries/b/")).headers.location).toBe("/ministries/d/");
    await rm(file());
    expect((await get(app, "/ministries/a/")).status).toBe(404);
  });

  it("resolveMinistrySuccessor: the table's target, case-insensitively, or null", async () => {
    await writeTable({ a: "c" });
    expect(await resolveMinistrySuccessor(outputDir, "a")).toBe("c");
    expect(await resolveMinistrySuccessor(outputDir, "A")).toBe("c");
    expect(await resolveMinistrySuccessor(outputDir, "c")).toBeNull();
    expect(await resolveMinistrySuccessor(outputDir, "constructor")).toBeNull();
  });
});

describe("mountSite with successor redirects", () => {
  let outputDir: string;
  beforeEach(async () => {
    outputDir = await mkdtemp(join(tmpdir(), "gcpe-site-mount-successors-"));
    // The old ministry's page still builds (getMinistry has no active filter): the redirect must win.
    for (const k of ["a", "c"]) {
      await mkdir(join(outputDir, "ministries", k), { recursive: true });
      await writeFile(join(outputDir, "ministries", k, "index.html"), `<h1>${k}</h1>`);
    }
    await mkdir(join(outputDir, "legacy"), { recursive: true });
    await writeFile(join(outputDir, "legacy", "ministry-successors.json"), JSON.stringify({ successors: { a: "c" } }));
  });
  afterEach(async () => {
    await rm(outputDir, { recursive: true, force: true });
  });
  const appFor = (basePath: string) => {
    const app = express();
    mountSite(app, { outputDir, basePath });
    return app;
  };

  it("base '/site': both /site/ministries/a/ and /ministries/a/ redirect, each keeping its own prefix", async () => {
    const app = appFor("/site");
    const prefixed = await request(app).get("/site/ministries/a/feed.xml?x=1").redirects(0);
    expect(prefixed.status).toBe(301);
    expect(prefixed.headers.location).toBe("/site/ministries/c/feed.xml?x=1");
    const root = await request(app).get("/ministries/a/").redirects(0);
    expect(root.status).toBe(301);
    expect(root.headers.location).toBe("/ministries/c/");
    expect((await request(app).get("/site/ministries/c/")).text).toBe("<h1>c</h1>");
    expect((await request(app).get("/ministries/c/")).text).toBe("<h1>c</h1>");
  });

  it("base '': /ministries/a/ → /ministries/c/, and /site/ministries/a/ goes there in one hop", async () => {
    const app = appFor("");
    expect((await request(app).get("/ministries/a/").redirects(0)).headers.location).toBe("/ministries/c/");
    const alias = await request(app).get("/site/ministries/a/feed.xml?x=1").redirects(0);
    expect(alias.status).toBe(301);
    expect(alias.headers.location).toBe("/ministries/c/feed.xml?x=1");
    // Anything else under /site still takes the plain alias redirect.
    expect((await request(app).get("/site/ministries/c/").redirects(0)).headers.location).toBe("/ministries/c/");
  });
});

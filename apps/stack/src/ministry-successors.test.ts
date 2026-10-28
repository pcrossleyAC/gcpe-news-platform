import { chmod, mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import { resolveMinistrySuccessor } from "./ministry-successors";
import { mountSite } from "./site-mount";

describe("resolveMinistrySuccessor (the successor table)", () => {
  let outputDir: string;
  const file = () => join(outputDir, "legacy", "ministry-successors.json");
  const writeTable = async (successors: Record<string, string>, mtime?: Date) => {
    await mkdir(join(outputDir, "legacy"), { recursive: true });
    await writeFile(file(), JSON.stringify({ successors }));
    if (mtime) await utimes(file(), mtime, mtime);
  };
  const to = (key: string) => resolveMinistrySuccessor(outputDir, key);

  beforeEach(async () => {
    outputDir = await mkdtemp(join(tmpdir(), "gcpe-ministry-successors-"));
  });
  afterEach(async () => {
    await rm(outputDir, { recursive: true, force: true });
  });

  it("the table's target, case-insensitively, or null", async () => {
    await writeTable({ a: "c" });
    expect(await to("a")).toBe("c");
    expect(await to("A")).toBe("c");
    expect(await to("c")).toBeNull();
    expect(await to("constructor")).toBeNull();
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)("an unreadable file is an empty table, logged once, not per lookup", async () => {
    await writeTable({ a: "c" });
    await chmod(join(outputDir, "legacy"), 0o000);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      for (let i = 0; i < 3; i++) expect(await to("a")).toBeNull();
      expect(warn.mock.calls.filter(([m]) => String(m).includes("unreadable"))).toEqual([["[stack] ministry successors unreadable: EACCES"]]);
    } finally {
      warn.mockRestore();
      await chmod(join(outputDir, "legacy"), 0o755);
    }
    expect(await to("a")).toBe("c");
  });

  it("a table entry that isn't two lowercased category keys is ignored", async () => {
    await writeTable({ a: "//evil.example", b: "c/../d", e: "e", F: "c", g: "c" });
    for (const k of ["a", "b", "e", "f"]) expect(await to(k), k).toBeNull();
    expect(await to("g")).toBe("c");
  });

  it("a missing or malformed file is an empty table", async () => {
    expect(await to("a")).toBeNull();
    await mkdir(join(outputDir, "legacy"), { recursive: true });
    await writeFile(file(), "{not json");
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await to("a")).toBeNull();
    vi.restoreAllMocks();
  });

  it("an updated file is picked up; a deleted one empties the table", async () => {
    await writeTable({ a: "c" }, new Date("2026-10-28T10:00:00Z"));
    expect(await to("a")).toBe("c");
    await writeTable({ a: "d", b: "d" }, new Date("2026-10-28T10:00:05Z"));
    expect(await to("a")).toBe("d");
    expect(await to("b")).toBe("d");
    await rm(file());
    expect(await to("a")).toBeNull();
  });
});

describe("mountSite with successors", () => {
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
    // (Feeds are Task 8's: legacyUrls' category rule leaves /feed… alone, so this uses a listing path.)
    const prefixed = await request(app).get("/site/ministries/a/releases?x=1").redirects(0);
    expect(prefixed.status).toBe(301);
    expect(prefixed.headers.location).toBe("/site/ministries/c/?x=1");
    const root = await request(app).get("/ministries/a/").redirects(0);
    expect(root.status).toBe(301);
    expect(root.headers.location).toBe("/ministries/c/");
    expect((await request(app).get("/site/ministries/c/")).text).toBe("<h1>c</h1>");
    expect((await request(app).get("/ministries/c/")).text).toBe("<h1>c</h1>");
  });

  it("base '': /ministries/a/ → /ministries/c/, and /site/ministries/a/ goes there in one hop", async () => {
    const app = appFor("");
    expect((await request(app).get("/ministries/a/").redirects(0)).headers.location).toBe("/ministries/c/");
    const alias = await request(app).get("/site/ministries/a/?x=1").redirects(0);
    expect(alias.status).toBe(301);
    expect(alias.headers.location).toBe("/ministries/c/?x=1");
    // A feed is served in place from the successor's file (legacyUrls' feed rule), no hop.
    await writeFile(join(outputDir, "ministries", "c", "feed.xml"), "<rss>c</rss>");
    const feed = await request(app).get("/site/ministries/a/feed.xml?x=1").redirects(0);
    expect({ status: feed.status, body: feed.text }).toEqual({ status: 200, body: "<rss>c</rss>" });
    // Anything else under /site still takes the plain alias redirect.
    expect((await request(app).get("/site/ministries/c/").redirects(0)).headers.location).toBe("/ministries/c/");
  });
});

import { rm } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLegacySiteFixture } from "./fixture";
import { parseRequestTarget } from "./safe-path";
import { pagePath } from "./site-files";

describe("parseRequestTarget", () => {
  it("splits path and query, keeping the query bytes: /a%20b?x=A%2Bb → path '/a b', query '?x=A%2Bb'", () => {
    expect(parseRequestTarget("/a%20b?x=A%2Bb")).toEqual({ rawPath: "/a%20b", path: "/a b", query: "?x=A%2Bb" });
    expect(parseRequestTarget("/a")).toEqual({ rawPath: "/a", path: "/a", query: "" });
    expect(parseRequestTarget("/a?")).toEqual({ rawPath: "/a", path: "/a", query: "?" });
  });

  it("strips absolute-form: http://evil.example/Stories/x → path '/Stories/x'", () => {
    expect(parseRequestTarget("http://evil.example/Stories/x")).toEqual({ rawPath: "/Stories/x", path: "/Stories/x", query: "" });
    expect(parseRequestTarget("HTTPS://evil.example?x=1")).toEqual({ rawPath: "/", path: "/", query: "?x=1" });
  });

  it.each(["//evil.example", "/%2F%2Fevil.example", "/\\evil.example", "/a/../b", "/a/%2e%2e/b", "/%zz", "/a%00b"])("rejects %s", (raw) => {
    expect(parseRequestTarget(raw)).toBeNull();
  });

  it.each(["/a/./b", "/a/%2E/b", "/a%2Fb", "/a%5Cb", "/a%0Ab", "/a%7F", "http://evil.example//x", "x/y"])("also rejects %s", (raw) => {
    expect(parseRequestTarget(raw)).toBeNull();
  });

  // Windows file-name aliases: an NTFS stream (":"), an 8.3 short name ("~"), and a name with a
  // trailing "." or " " (Win32 strips them, so "health." opens "health").
  it.each([
    "/index.html::$DATA",
    "/index.html%3A%3A$DATA",
    "/releases/_long::$INDEX_ALLOCATION/x/",
    "/ministries/health./",
    "/ministries/health%2E/",
    "/ministries/health%20/",
    "/ministries/health /",
    "/SITE-S~1.JSO",
    "/releases/_LONG~1/x/",
    "/ministries/HEALTH~1/",
    "/archive/2026/10.",
  ])("rejects the Windows alias %s", (raw) => {
    expect(parseRequestTarget(raw)).toBeNull();
  });

  it("keeps ordinary names with a dot or a space inside a segment", () => {
    expect(parseRequestTarget("/feeds/releases.atom.xml")?.path).toBe("/feeds/releases.atom.xml");
    expect(parseRequestTarget("/a%20b/c.d")?.path).toBe("/a b/c.d");
    expect(parseRequestTarget("/x?q=a:b~c.")?.query).toBe("?q=a:b~c.");
  });
});

describe("pagePath", () => {
  let outputDir: string;
  beforeAll(async () => {
    outputDir = await createLegacySiteFixture();
  });
  afterAll(async () => {
    await rm(outputDir, { recursive: true, force: true });
  });

  it("a file → its URL path; a directory with index.html → one trailing slash; otherwise null", async () => {
    expect(await pagePath(outputDir, "/feed.xml")).toBe("/feed.xml");
    expect(await pagePath(outputDir, "/archive/2026/10")).toBe("/archive/2026/10/");
    expect(await pagePath(outputDir, "/archive/2026/10/")).toBe("/archive/2026/10/");
    expect(await pagePath(outputDir, "/")).toBe("/");
    expect(await pagePath(outputDir, "/archive/2026/09/")).toBeNull();
    expect(await pagePath(outputDir, "/archive/2026")).toBeNull(); // a directory without index.html
    expect(await pagePath(outputDir, "/feed.xml/")).toBeNull();
  });

  it.each(["/.site-state.json", "/a/../index.html", "/./index.html", "/..", "/a\\b", "/c:/x", "relative"])("never resolves %s", async (p) => {
    expect(await pagePath(outputDir, p)).toBeNull();
  });
});

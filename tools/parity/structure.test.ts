// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { PARITY_PAGES, PLAN4_PAGE_NAMES, buildOursUrl, parseOursOverrides } from "./pages";
import { STRUCTURE, structureFailed, structureReport } from "./structure";

describe("structureReport", () => {
  it("ok when both have the selector; missing when only legacy has it; legacy-absent when legacy lacks it", () => {
    const report = structureReport(
      { ".a": true, ".b": true, ".c": false, ".d": false },
      { ".a": true, ".b": false, ".c": true, ".d": false },
    );
    expect(report).toEqual([
      { selector: ".a", status: "ok" },
      { selector: ".b", status: "missing" },
      { selector: ".c", status: "legacy-absent" },
      { selector: ".d", status: "legacy-absent" },
    ]);
  });
});

describe("STRUCTURE", () => {
  it("every STRUCTURE key is a PARITY_PAGES name, and every selector parses", () => {
    const names = new Set(PARITY_PAGES.map((p) => p.name));
    for (const [page, selectors] of Object.entries(STRUCTURE)) {
      expect(names.has(page), page).toBe(true);
      expect(selectors.length).toBeGreaterThan(0);
      for (const s of selectors) expect(() => document.querySelector(s), s).not.toThrow();
    }
  });

  it("every PARITY_PAGES name has a STRUCTURE entry", () => {
    for (const p of PARITY_PAGES) expect(STRUCTURE[p.name], p.name).toBeDefined();
  });

  it("oursPath of every plan-4 page ends with '/'", () => {
    for (const name of PLAN4_PAGE_NAMES) {
      const p = PARITY_PAGES.find((x) => x.name === name);
      expect(p, name).toBeDefined();
      expect(p!.oursPath, name).toMatch(/\/$/);
    }
    expect(PARITY_PAGES.find((p) => p.name === "topics")).toMatchObject({ path: "/news-subscribe", oursPath: "/tags/" });
    expect(PARITY_PAGES.find((p) => p.name === "archive")).toMatchObject({ path: "/stories", oursPath: "/archive/2026/10/" });
  });

  it("biography and premier pages are registered with ours paths", () => {
    expect(PARITY_PAGES.find((p) => p.name === "biography")).toEqual({
      name: "biography",
      path: "/ministries/citizens-services/biography",
      oursPath: "/ministries/citizens-services/biography/",
    });
    expect(PARITY_PAGES.find((p) => p.name === "premier")).toEqual({
      name: "premier",
      path: "/office-of-the-premier",
      oursPath: "/ministries/office-of-the-premier/",
    });
  });
});

describe("parseOursOverrides", () => {
  it("maps names to paths; an unknown page name throws", () => {
    expect(parseOursOverrides("release=/releases/A/,home=/x/")).toEqual({ release: "/releases/A/", home: "/x/" });
    expect(() => parseOursOverrides("nope=/x/")).toThrow(/nope/);
    expect(() => parseOursOverrides("release")).toThrow();
  });
});

describe("parseOursOverrides path validation", () => {
  it.each(["release=//evil.com/x", "release=@evil.com/x", "release=/../x", "release=/a/..%2f", "release=https://evil.com/", "release=/a\\b", "release=releases/A/", "release=/a b"])(
    "rejects %s",
    (spec) => {
      expect(() => parseOursOverrides(spec)).toThrow(/--ours/);
    },
  );
});

describe("buildOursUrl", () => {
  it("keeps the target's path prefix and origin", () => {
    expect(buildOursUrl("https://boxs.ca/site", "/releases/A/")).toBe("https://boxs.ca/site/releases/A/");
    expect(buildOursUrl("https://boxs.ca/site/", "/search?q=housing")).toBe("https://boxs.ca/site/search?q=housing");
    expect(buildOursUrl("https://boxs.ca", "/")).toBe("https://boxs.ca/");
  });
  it("throws when the result leaves the target origin or prefix", () => {
    expect(() => buildOursUrl("https://boxs.ca/site", "/../../x")).toThrow(/escapes/);
    expect(() => buildOursUrl("https://boxs.ca/site", "/../x")).toThrow(/escapes/);
  });
});

describe("structureFailed", () => {
  it("fails only on missing; legacy-absent and ok pass", () => {
    expect(structureFailed([{ selector: ".a", status: "ok" }, { selector: ".b", status: "legacy-absent" }])).toBe(false);
    expect(structureFailed([{ selector: ".a", status: "ok" }, { selector: ".b", status: "missing" }])).toBe(true);
    expect(structureFailed([])).toBe(false);
  });
});

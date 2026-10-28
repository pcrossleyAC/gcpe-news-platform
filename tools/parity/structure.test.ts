// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { PARITY_PAGES, parseOursOverrides } from "./pages";
import { STRUCTURE, structureReport } from "./structure";

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

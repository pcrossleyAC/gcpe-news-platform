import { describe, expect, it } from "vitest";
import { plainLanguageProblems, parsePage, readManualPages } from "../../../../scripts/manuals-lib.mjs";

describe("manual pages use plain language", () => {
  const pages = readManualPages();
  it("finds the manual pages", () => {
    expect(pages.length).toBeGreaterThan(0);
  });
  for (const { path, text } of pages) {
    it(path, () => {
      expect(plainLanguageProblems(parsePage(path, text).body)).toEqual([]);
    });
  }
});

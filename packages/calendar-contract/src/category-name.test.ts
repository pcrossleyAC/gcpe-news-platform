import { describe, expect, it } from "vitest";
import { hasCategoryStartingWith, sameCategoryName } from "./category-name";

describe("sameCategoryName (legacy category 16: 'Speech /  Remarks', two spaces)", () => {
  it("matches names that differ only by doubled internal whitespace", () => {
    expect(sameCategoryName("Speech /  Remarks", "Speech / Remarks")).toBe(true);
  });
  it("matches names that differ only by a leading or trailing space", () => {
    expect(sameCategoryName(" Speech / Remarks", "Speech / Remarks")).toBe(true);
    expect(sameCategoryName("Speech / Remarks ", "Speech / Remarks")).toBe(true);
  });
  it("still tells apart names that genuinely differ", () => {
    expect(sameCategoryName("Speech / Remarks", "Speeches / Remarks")).toBe(false);
  });
  it("does not fold case: that is a different, unrequested normalisation", () => {
    expect(sameCategoryName("speech / remarks", "Speech / Remarks")).toBe(false);
  });
});

describe("hasCategoryStartingWith (legacy's \"Approved\" test: News/Services.asmx.cs:87, ReleasesModel.cs:155)", () => {
  it("is true when any category starts with the prefix", () => {
    expect(hasCategoryStartingWith(["Sample event", "Approved Release"], "Approved")).toBe(true);
    expect(hasCategoryStartingWith(["Proposed Release"], "Approved")).toBe(false);
    expect(hasCategoryStartingWith([], "Approved")).toBe(false);
  });
  it("ignores case and stray whitespace, as legacy's SQL Server collation and markup did", () => {
    expect(hasCategoryStartingWith(["  approved  event"], "Approved event")).toBe(true);
  });
  it("matches at the start only", () => {
    expect(hasCategoryStartingWith(["Not Approved"], "Approved")).toBe(false);
  });
});

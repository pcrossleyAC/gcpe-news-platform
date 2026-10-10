import { describe, expect, it } from "vitest";
import { sameCategoryName } from "./category-name";

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

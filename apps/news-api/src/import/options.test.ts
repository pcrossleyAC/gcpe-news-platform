import { describe, expect, it } from "vitest";
import { parseImportCliOptions } from "./options";

describe("parseImportCliOptions", () => {
  it("defaults: keep slides on an empty carousel, unpublish missing posts", () => {
    expect(parseImportCliOptions([], {})).toEqual({ allowEmptySlides: false, unpublishMissing: true });
  });

  it("--allow-empty-slides and LEGACY_ALLOW_EMPTY_SLIDES=true both enable clearing slides", () => {
    expect(parseImportCliOptions(["--allow-empty-slides"], {}).allowEmptySlides).toBe(true);
    expect(parseImportCliOptions([], { LEGACY_ALLOW_EMPTY_SLIDES: "true" }).allowEmptySlides).toBe(true);
    expect(parseImportCliOptions([], { LEGACY_ALLOW_EMPTY_SLIDES: "false" }).allowEmptySlides).toBe(false);
  });

  it("--no-unpublish-missing and LEGACY_UNPUBLISH_MISSING=false both disable unpublishing", () => {
    expect(parseImportCliOptions(["--no-unpublish-missing"], {}).unpublishMissing).toBe(false);
    expect(parseImportCliOptions([], { LEGACY_UNPUBLISH_MISSING: "false" }).unpublishMissing).toBe(false);
  });

  it("rejects unknown arguments", () => {
    expect(() => parseImportCliOptions(["--allow-empty-slide"], {})).toThrow(/Unknown argument: --allow-empty-slide/);
  });
});

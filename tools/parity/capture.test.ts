import { describe, expect, it } from "vitest";
import { classify, navigationError } from "./capture";

describe("classify", () => {
  it.each([
    ["banner absent on one side is skipped, not missing", "banner", true, false, null, "skipped"],
    ["banner absent on both sides is skipped", "banner", false, false, null, "skipped"],
    ["a strict region absent on ours is missing", "header", true, false, null, "missing"],
    ["a strict region absent on legacy is missing", "footer", false, true, null, "missing"],
    ["a ratio above STRICT_MAX is a mismatch", "header", true, true, 0.031, "mismatch"],
    ["a ratio at STRICT_MAX is ok", "header", true, true, 0.03, "ok"],
    ["banner present on both sides is diffed like any region", "banner", true, true, 0.5, "mismatch"],
  ] as const)("%s", (_label, region, legacy, ours, ratio, want) => {
    expect(classify(region, legacy, ours, ratio)).toBe(want);
  });
});

describe("navigationError", () => {
  it("2xx is fine; anything else (or no response) is a load error naming the status", () => {
    expect(navigationError(200)).toBeNull();
    expect(navigationError(204)).toBeNull();
    expect(navigationError(404)).toBe("HTTP 404");
    expect(navigationError(500)).toBe("HTTP 500");
    expect(navigationError(301)).toBe("HTTP 301");
    expect(navigationError(null)).toBe("no response");
  });
});

import { describe, expect, it } from "vitest";
import { safeReturnTo } from "./safeReturnTo";

describe("safeReturnTo", () => {
  it("accepts a same-origin absolute path", () => {
    expect(safeReturnTo("/releases/abc-123")).toBe("/releases/abc-123");
    expect(safeReturnTo("/releases/abc-123?tab=history")).toBe("/releases/abc-123?tab=history");
  });

  it("falls back to / for null, empty, or a path with no leading slash", () => {
    expect(safeReturnTo(null)).toBe("/");
    expect(safeReturnTo("")).toBe("/");
    expect(safeReturnTo("releases/abc")).toBe("/");
  });

  // "//evil.com" (and "/\evil.com", which browsers treat the same way) is a protocol-relative
  // URL: react-router's own <Navigate>/history would otherwise happily hand it to the browser
  // as a navigation to a different origin. Never trust react-router's resolution alone here.
  it("falls back to / for a protocol-relative URL (//evil.com)", () => {
    expect(safeReturnTo("//evil.com")).toBe("/");
    expect(safeReturnTo("//evil.com/path")).toBe("/");
  });

  it("falls back to / for an absolute URL to another origin", () => {
    expect(safeReturnTo("https://evil.com")).toBe("/");
    expect(safeReturnTo("http://evil.com/x")).toBe("/");
  });
});

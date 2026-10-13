import { describe, expect, it } from "vitest";
import { safeHubReturnTo } from "./return-to";

describe("safeHubReturnTo", () => {
  it.each([
    ["/hub/releases/drafts", "/hub/releases/drafts"],
    ["/hub/search?q=fire#top", "/hub/search?q=fire#top"],
    ["/hub", "/hub/"],
    ["/hub/", "/hub/"],
  ])("keeps %s", (value, expected) => {
    expect(safeHubReturnTo(value)).toBe(expected);
  });

  it.each([
    ["missing", undefined],
    ["an array", ["/hub/a", "/hub/b"]],
    ["empty", ""],
    ["relative", "hub/releases"],
    ["protocol-relative", "//evil.example.test/hub/"],
    ["backslash", "/\\evil.example.test"],
    ["absolute", "https://evil.example.test/hub/"],
    ["outside /hub", "/core/api/users"],
    ["a /hub prefix only", "/hubx/releases"],
    ["dot segments leaving /hub", "/hub/../core/api/users"],
    ["encoded dot segments", "/hub/%2e%2e/core"],
    ["a control character", "/hub/\nset-cookie"],
    ["too long", `/hub/${"a".repeat(600)}`],
  ])("refuses %s", (_label, value) => {
    expect(safeHubReturnTo(value)).toBe("/hub/");
  });
});

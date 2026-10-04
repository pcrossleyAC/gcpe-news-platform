import { describe, expect, it } from "vitest";
import { blueBridgeBanner, isGranvilleOn, isTestSite } from "./site-env";

describe("isTestSite", () => {
  it("production, nothing else set: false", () => {
    expect(isTestSite({ NODE_ENV: "production" })).toBe(false);
  });

  it("production with LOCAL_ADMIN_ALLOW_IN_PRODUCTION=true: true (a test deployment, e.g. boxs.ca)", () => {
    expect(isTestSite({ NODE_ENV: "production", LOCAL_ADMIN_ALLOW_IN_PRODUCTION: "true" })).toBe(true);
  });

  it("not production at all (e.g. development): true", () => {
    expect(isTestSite({ NODE_ENV: "development" })).toBe(true);
  });

  it("production with SITE_ENVIRONMENT=test: true", () => {
    expect(isTestSite({ NODE_ENV: "production", SITE_ENVIRONMENT: "test" })).toBe(true);
  });

  it("production with LOCAL_ADMIN_ALLOW_IN_PRODUCTION=false and no SITE_ENVIRONMENT: false", () => {
    expect(isTestSite({ NODE_ENV: "production", LOCAL_ADMIN_ALLOW_IN_PRODUCTION: "false" })).toBe(false);
  });
});

// Fix round 1 (IMPORTANT 2): legacy stores "true"/"false"; ON iff the trimmed, case-insensitive
// value is exactly "true" — not "any non-empty string".
describe("isGranvilleOn", () => {
  it.each([
    ["true", true],
    ["TRUE", true],
    [" true ", true],
    ["false", false],
    ["FALSE", false],
    ["", false],
    [null, false],
    ["on", false],
    ["off", false],
  ] as const)("isGranvilleOn(%j) === %j", (value, expected) => {
    expect(isGranvilleOn(value)).toBe(expected);
  });
});

describe("blueBridgeBanner", () => {
  it("granville null: no banner", () => {
    expect(blueBridgeBanner(null, new Date("2026-10-04T18:00:00Z"), false)).toBeNull();
  });

  it("granville empty string: no banner", () => {
    expect(blueBridgeBanner("", new Date("2026-10-04T18:00:00Z"), false)).toBeNull();
  });

  // Fix round 1 (IMPORTANT 2): a legacy-imported "false" (or any non-"true" value) must never
  // publish the banner.
  it.each(["false", "FALSE", ""])("granville %j: no banner", (value) => {
    expect(blueBridgeBanner(value, new Date("2026-10-04T18:00:00Z"), false)).toBeNull();
  });

  it("granville ' true ' (whitespace, lower-case): banner shown", () => {
    expect(blueBridgeBanner(" true ", new Date("2026-10-04T18:00:00Z"), false)).toContain("ALERT:");
  });

  it("on, before his birthday this year (BC time): age 77", () => {
    const banner = blueBridgeBanner("true", new Date("2026-10-04T18:00:00Z"), false);
    expect(banner).toBe("ALERT: His Majesty King Charles III, King of Canada, has passed away at the age of 77");
  });

  it("on, on/after his birthday this year (BC time): age 78", () => {
    const banner = blueBridgeBanner("true", new Date("2026-11-14T18:00:00Z"), false);
    expect(banner).toBe("ALERT: His Majesty King Charles III, King of Canada, has passed away at the age of 78");
  });

  it("a test site prefixes the banner with TEST — ", () => {
    const banner = blueBridgeBanner("true", new Date("2026-10-04T18:00:00Z"), true);
    expect(banner?.startsWith("TEST — ALERT:")).toBe(true);
  });

  // The UTC calendar date can already be Nov 14 while it's still Nov 13 in BC (UTC-8 in
  // November, standard time) — the age calculation must use BC time, not UTC, or this would
  // read 78 a day early.
  it("uses BC time, not UTC, for the age boundary", () => {
    // 2026-11-14T06:00:00Z is 2026-11-13T22:00:00-08:00 — the day BEFORE his birthday in BC,
    // even though the UTC calendar date is already the 14th.
    expect(blueBridgeBanner("true", new Date("2026-11-14T06:00:00Z"), false)).toContain("age of 77");
    // 2026-11-15T06:00:00Z is 2026-11-14T22:00:00-08:00 — his birthday, BC time.
    expect(blueBridgeBanner("true", new Date("2026-11-15T06:00:00Z"), false)).toContain("age of 78");
  });
});

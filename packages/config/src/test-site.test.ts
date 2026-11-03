import { describe, expect, it } from "vitest";
import { environmentName, isRealProduction, isTestSite, type TestSiteEnv } from "./index";

// The rule as an oracle, so any change to the shared helper's behaviour fails this table. Owner
// decision 2026-10-31 (production configuration, T1): LOCAL_ADMIN_ALLOW_IN_PRODUCTION no longer
// marks a test site; it only permits the break-glass admin. Only NODE_ENV and SITE_ENVIRONMENT count.
// Fix round 2 (R1): SITE_ENVIRONMENT is read ignoring case and surrounding spaces, failing toward a test site.
const before = (env: TestSiteEnv & { LOCAL_ADMIN_ALLOW_IN_PRODUCTION?: string }) => env.NODE_ENV !== "production" || env.SITE_ENVIRONMENT?.trim().toLowerCase() === "test";

const NODE_ENV = [undefined, "", "production", "Production", "development", "test"];
const ALLOW = [undefined, "", "true", "TRUE", "false", "1"];
const SITE = [undefined, "", "test", "TEST", "production"];

describe("the test-site rule", () => {
  it("matches the rule every app used before, for every combination", () => {
    let n = 0;
    for (const a of NODE_ENV)
      for (const b of ALLOW)
        for (const c of SITE) {
          const env = { NODE_ENV: a, LOCAL_ADMIN_ALLOW_IN_PRODUCTION: b, SITE_ENVIRONMENT: c };
          expect(isTestSite(env), JSON.stringify(env)).toBe(before(env));
          expect(isRealProduction(env), JSON.stringify(env)).toBe(!before(env));
          n++;
        }
    expect(n).toBe(180);
  });

  it("break-glass allowed in production (LOCAL_ADMIN_ALLOW_IN_PRODUCTION=true) with no SITE_ENVIRONMENT is real production", () => {
    const env: NodeJS.ProcessEnv = { NODE_ENV: "production", LOCAL_ADMIN_ALLOW_IN_PRODUCTION: "true", LOCAL_ADMIN_ENABLED: "true" };
    expect(isRealProduction(env)).toBe(true);
    expect(isTestSite({ ...env, SITE_ENVIRONMENT: "test" })).toBe(true);
  });

  it("reads the two variables straight from process.env's shape, ignoring everything else", () => {
    expect(isRealProduction({ NODE_ENV: "production" })).toBe(true);
    expect(isTestSite({ NODE_ENV: "production", SITE_ENVIRONMENT: "test" })).toBe(true);
    expect(isTestSite({ NODE_ENV: "production", SITE_ENVIRONMENT: "test" })).toBe(true);
    expect(isTestSite({})).toBe(true);
    const env: NodeJS.ProcessEnv = { NODE_ENV: "production", FAKE_ENTRA_ENABLED: "true" };
    expect(isRealProduction(env)).toBe(true);
  });

  it("reads SITE_ENVIRONMENT ignoring case and surrounding spaces (fix round 2, R1)", () => {
    for (const v of ["Test", "test ", " TEST\t"]) expect(isTestSite({ NODE_ENV: "production", SITE_ENVIRONMENT: v }), JSON.stringify(v)).toBe(true);
    for (const v of [undefined, "", "production", "staging"]) expect(isRealProduction({ NODE_ENV: "production", SITE_ENVIRONMENT: v }), JSON.stringify(v)).toBe(true);
  });
});

describe("environmentName (C331: the Hub's environment banner)", () => {
  const PROD = { NODE_ENV: "production", SITE_ENVIRONMENT: "production" };
  it("real production never has one, whatever ENVIRONMENT_NAME says", () => {
    for (const n of [undefined, "", "DEV", "TEST", "PROD"]) expect(environmentName({ ...PROD, ENVIRONMENT_NAME: n })).toBeNull();
    expect(environmentName({ NODE_ENV: "production", ENVIRONMENT_NAME: "DEV" })).toBeNull();
  });
  it("a test site shows ENVIRONMENT_NAME, upper-cased and trimmed, or TEST when it isn't set", () => {
    const test = { NODE_ENV: "production", SITE_ENVIRONMENT: "test" };
    expect(environmentName(test)).toBe("TEST");
    expect(environmentName({ ...test, ENVIRONMENT_NAME: "  dev " })).toBe("DEV");
    expect(environmentName({ ...test, ENVIRONMENT_NAME: "uat" })).toBe("UAT");
    expect(environmentName({ NODE_ENV: "development" })).toBe("TEST");
  });
  it("keeps only letters, digits, spaces and hyphens, at most 20 characters", () => {
    const test = { NODE_ENV: "production", SITE_ENVIRONMENT: "test" };
    expect(environmentName({ ...test, ENVIRONMENT_NAME: "<b>dev</b>" })).toBe("BDEVB");
    expect(environmentName({ ...test, ENVIRONMENT_NAME: "x".repeat(40) })).toBe("X".repeat(20));
    expect(environmentName({ ...test, ENVIRONMENT_NAME: "!!!" })).toBe("TEST");
  });
});

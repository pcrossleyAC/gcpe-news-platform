import { describe, expect, it } from "vitest";
import { isRealProduction, isTestSite, type TestSiteEnv } from "./index";

// The rule as an oracle, so any change to the shared helper's behaviour fails this table. Owner
// decision 2026-10-31 (production configuration, T1): LOCAL_ADMIN_ALLOW_IN_PRODUCTION no longer
// marks a test site; it only permits the break-glass admin. Only NODE_ENV and SITE_ENVIRONMENT count.
const before = (env: TestSiteEnv & { LOCAL_ADMIN_ALLOW_IN_PRODUCTION?: string }) => env.NODE_ENV !== "production" || env.SITE_ENVIRONMENT === "test";

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
});

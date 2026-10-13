import { describe, expect, it } from "vitest";
import { isRealProduction, isTestSite, type TestSiteEnv } from "./index";

// The rule exactly as the five copies wrote it before they were merged. Kept here verbatim as the
// oracle, so any change to the shared helper's behaviour fails this table.
const before = (env: TestSiteEnv) => env.NODE_ENV !== "production" || env.LOCAL_ADMIN_ALLOW_IN_PRODUCTION === "true" || env.SITE_ENVIRONMENT === "test";

const NODE_ENV = [undefined, "", "production", "Production", "development", "test"];
const ALLOW = [undefined, "", "true", "TRUE", "false", "1"];
const SITE = [undefined, "", "test", "TEST", "production"];

describe("the test-site rule", () => {
  it("matches the rule every app used before, for every combination", () => {
    let n = 0;
    for (const a of NODE_ENV)
      for (const b of ALLOW)
        for (const c of SITE) {
          const env: TestSiteEnv = { NODE_ENV: a, LOCAL_ADMIN_ALLOW_IN_PRODUCTION: b, SITE_ENVIRONMENT: c };
          expect(isTestSite(env), JSON.stringify(env)).toBe(before(env));
          expect(isRealProduction(env), JSON.stringify(env)).toBe(!before(env));
          n++;
        }
    expect(n).toBe(180);
  });

  it("reads the three variables straight from process.env's shape, ignoring everything else", () => {
    expect(isRealProduction({ NODE_ENV: "production" })).toBe(true);
    expect(isTestSite({ NODE_ENV: "production", LOCAL_ADMIN_ALLOW_IN_PRODUCTION: "true" })).toBe(true);
    expect(isTestSite({ NODE_ENV: "production", SITE_ENVIRONMENT: "test" })).toBe(true);
    expect(isTestSite({})).toBe(true);
    const env: NodeJS.ProcessEnv = { NODE_ENV: "production", FAKE_ENTRA_ENABLED: "true" };
    expect(isRealProduction(env)).toBe(true);
  });
});

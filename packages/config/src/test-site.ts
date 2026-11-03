/** The two shared, unprefixed stack variables the rule reads. `process.env` fits this shape. */
export interface TestSiteEnv {
  NODE_ENV?: string | undefined;
  SITE_ENVIRONMENT?: string | undefined;
  /** Display only (C331): the name the Hub's environment banner shows, such as DEV or TEST. */
  ENVIRONMENT_NAME?: string | undefined;
}

/**
 * The platform's one test-site rule. A deployment is a test site unless it is the real
 * production deployment: NODE_ENV isn't "production", or it is but the deployment is marked as a
 * test site anyway with SITE_ENVIRONMENT=test (boxs.ca, the Windows Dev and Test servers).
 *
 * Owner decision 2026-10-31 (production configuration, T1): LOCAL_ADMIN_ALLOW_IN_PRODUCTION used
 * to mark a test site too. It now only permits the break-glass admin (packages/auth's from-env.ts),
 * so turning break-glass on in an emergency no longer makes the live site a test site.
 * No imports, so any package can use it.
 */
export function isTestSite(env: TestSiteEnv): boolean {
  return env.NODE_ENV !== "production" || siteEnvironment(env) === "test";
}

/** SITE_ENVIRONMENT as the rule reads it (fix round 2, R1): trimmed and lower-cased, so "Test " is a
 * test site (failing toward test); "" when unset. The stack refuses any other value than "test" or
 * "production" under NODE_ENV=production (apps/stack/src/env.ts productionProblems). */
export function siteEnvironment(env: TestSiteEnv): string {
  return (env.SITE_ENVIRONMENT ?? "").trim().toLowerCase();
}

/** The real production deployment: not a test site. */
export function isRealProduction(env: TestSiteEnv): boolean {
  return !isTestSite(env);
}

/**
 * The name the Hub's environment banner shows (C331), or null for none: real production never has
 * one, whatever is set, so the banner can't be switched on there by mistake. A test site shows
 * ENVIRONMENT_NAME (trimmed, upper-cased, at most 20 characters; letters, digits, spaces and
 * hyphens only), or TEST when it isn't set. Display only: it decides nothing else.
 */
export function environmentName(env: TestSiteEnv): string | null {
  if (!isTestSite(env)) return null;
  const name = (env.ENVIRONMENT_NAME ?? "").replace(/[^A-Za-z0-9 -]/g, "").trim().toUpperCase().slice(0, 20);
  return name || "TEST";
}

/** The two shared, unprefixed stack variables the rule reads. `process.env` fits this shape. */
export interface TestSiteEnv {
  NODE_ENV?: string | undefined;
  SITE_ENVIRONMENT?: string | undefined;
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
  return env.NODE_ENV !== "production" || env.SITE_ENVIRONMENT === "test";
}

/** The real production deployment: not a test site. */
export function isRealProduction(env: TestSiteEnv): boolean {
  return !isTestSite(env);
}

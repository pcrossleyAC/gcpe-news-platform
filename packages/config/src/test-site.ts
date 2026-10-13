/** The three shared, unprefixed stack variables the rule reads. `process.env` fits this shape. */
export interface TestSiteEnv {
  NODE_ENV?: string | undefined;
  LOCAL_ADMIN_ALLOW_IN_PRODUCTION?: string | undefined;
  SITE_ENVIRONMENT?: string | undefined;
}

/**
 * The platform's one test-site rule. A deployment is a test site unless it is the real
 * production deployment: NODE_ENV isn't "production", or it is but the deployment is marked as a
 * test site anyway, by LOCAL_ADMIN_ALLOW_IN_PRODUCTION=true (boxs.ca) or SITE_ENVIRONMENT=test.
 * No imports, so any package can use it.
 */
export function isTestSite(env: TestSiteEnv): boolean {
  return env.NODE_ENV !== "production" || env.LOCAL_ADMIN_ALLOW_IN_PRODUCTION === "true" || env.SITE_ENVIRONMENT === "test";
}

/** The real production deployment: not a test site. */
export function isRealProduction(env: TestSiteEnv): boolean {
  return !isTestSite(env);
}

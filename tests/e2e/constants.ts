/**
 * Shared, fixed test-only values for the Playwright acceptance suite (task-6-brief.md). These
 * are never real credentials — the whole stack runs in-process against throwaway test
 * databases for the duration of one `npm run test:e2e` invocation (tests/e2e/global-setup.ts).
 *
 * global-setup.ts also publishes the actually-bound base URL on `process.env.E2E_BASE_URL`
 * (the port is probed free, same trick as apps/stack/src/stack.test.ts) — Playwright's test
 * worker processes are forked from the main CLI process *after* globalSetup finishes, so they
 * inherit that env var. support.ts's {@link baseUrl} reads it back.
 */
export const TICK_TOKEN = `e2e-tick-token-${"t".repeat(32)}`;
export const ADMIN_PASSWORD = "e2e-admin-password-99";
export const ADMIN_USERNAME = "admin";

/** Shared by global-setup.ts (every app's `LOCAL_AUTH_SECRET`) and bounces.spec.ts, which mints
 * its own short-lived local token (`@gcpe/auth`'s `mintLocalToken`) to call Distribution
 * directly — the same thing NoD's own `distributionTokenProvider` does in local/test mode
 * (apps/nod/src/distribution-token.ts), just from the test rather than from NoD's process. */
export const LOCAL_AUTH_SECRET = "e2e-local-auth-secret-32-characters-long!";

/** `NOD_BOUNCE_SUMMARY_EMAIL` (global-setup.ts) — item 9's daily bounce summary recipient. */
export const BOUNCE_SUMMARY_EMAIL = "bounce-manager@example.test";

export const TEST_USER_PASSWORDS: Record<string, string> = {
  "editor@example.test": "e2e-editor-password-1",
  "site-editor@example.test": "e2e-site-editor-password-1",
  "viewer@example.test": "e2e-viewer-password-1",
};

export const EDITOR_EMAIL = "editor@example.test";
export const SITE_EDITOR_EMAIL = "site-editor@example.test";
export const VIEWER_EMAIL = "viewer@example.test";

export const SESSION_COOKIE = "gcpe_session";

/** Legacy `Subscribe/SubscriberInformation` (C55) Basic Auth credentials — global-setup.ts hashes
 * the password with `hashPassword` (the same function `npm run nod:membership-hash` wraps) and
 * passes `NOD_MEMBERSHIP_API_USERNAME`/`NOD_MEMBERSHIP_API_PASSWORD_HASH` to the stack. */
export const MEMBERSHIP_API_USERNAME = "e2e-media-hub";
export const MEMBERSHIP_API_PASSWORD = "e2e-membership-password-7";

/** apps/nrms/test/helpers.ts's seedTaxonomy — ministries, sectors, themes, tags, media lists
 * this suite can rely on existing. */
export const MINISTRY_HEALTH = "health";
export const MINISTRY_FINANCE = "finance";
export const SECTOR_HEALTH = "health";
export const SECTOR_EDUCATION = "education";
export const THEME_FAMILIES = "families";
export const TAG_COVID = "covid-19";

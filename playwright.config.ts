import { defineConfig, devices } from "@playwright/test";

/**
 * Playwright acceptance suite (task-6-brief.md): proves Phase 3's 16-item acceptance list
 * (docs/superpowers/specs/2026-10-03-nrms-parity-design.md §9) against the whole stack running
 * locally. `tests/e2e/global-setup.ts` starts the stack once (fresh test databases, the fake
 * Flickr, an SMTP sink, a freshly built staff-web, and the staff test users) and publishes its
 * base URL on `process.env.E2E_BASE_URL` for every spec to read (tests/e2e/support.ts).
 *
 * `workers: 1`: every spec shares that one stack/database instance, so specs must not run
 * concurrently against it. Not part of the default `npm test` (vitest) run — these are
 * `tests/e2e/*.spec.ts`, which the root vitest config's `include` globs (`*.test.ts`) never
 * match.
 */
export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: /.*\.spec\.ts/,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  globalSetup: "./tests/e2e/global-setup.ts",
  use: {
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});

// Acceptance item 15: "Import of the sample data: the report balances; a re-run changes
// nothing; scheduled releases stay on hold; replay sends no email."
//
// The legacy importer has no staff-web UI at all (apps/nrms/src/import/cli.ts is a standalone
// CLI; codemap.md §9 and task-6-brief.md both call this out explicitly) — there is nothing for
// a browser-driven Playwright spec to exercise. This item is proven by the importer's own
// Vitest suite against real Postgres instead:
//   - apps/nrms/src/import/run.test.ts            — the end-to-end import run and its report
//   - apps/nrms/src/import/releases.test.ts        — on-hold scheduled releases, re-run idempotency
//   - apps/nrms/src/import/report.test.ts          — the balance report itself
//   - apps/nrms/src/import/website.test.ts         — the website-side import
//   - apps/nrms/src/import/redact.test.ts          — replay sends no email (redaction before replay)
// `npm run test` runs all of them as part of the full Vitest suite; `npm run nrms:import` is
// the real CLI entry point (package.json).
import { test } from "@playwright/test";

test.skip("item 15 (importer): no staff-web UI exists for this — see apps/nrms/src/import/*.test.ts", () => {
  // Intentionally empty — this test exists only so the suite's acceptance-item index names item
  // 15 explicitly instead of silently omitting it.
});

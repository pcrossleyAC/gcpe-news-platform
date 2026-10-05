// Acceptance item 4: "Approve assigns a legacy-format Key and `NEWS-` reference; 20 concurrent
// approvals produce 20 distinct numbers." Driven directly against the API (not the UI) — the
// concurrency itself is the thing under test, not the button click.
import { test, expect } from "@playwright/test";
import { EDITOR_EMAIL, TEST_USER_PASSWORDS } from "./constants";
import { approveRelease, createPublishableRelease, loginForCookie } from "./playwright-support";

test.describe("item 4: approve numbering", () => {
  test("approve assigns a legacy-format key and a NEWS- reference", async () => {
    const cookie = await loginForCookie(EDITOR_EMAIL, TEST_USER_PASSWORDS[EDITOR_EMAIL]!);
    const created = await createPublishableRelease(cookie);
    expect(created.key).toBeNull();
    expect(created.reference).toBeNull();

    const approved = await approveRelease(cookie, created);
    expect(approved.status).toBe("approved");
    expect(approved.reference).toMatch(/^NEWS-\d{5}$/);
    // apps/nrms/src/releases/workflow.ts: `{year}{ministry abbreviation}{counter}-{sub}` — the
    // sample release's lead ministry is "health", abbreviation HLTH (apps/nrms/test/helpers.ts
    // seedTaxonomy).
    expect(approved.key).toMatch(/^\d{4}HLTH\d{4}-\d{6}$/);
  });

  test("20 concurrent approvals produce 20 distinct keys and 20 distinct references", async () => {
    const cookie = await loginForCookie(EDITOR_EMAIL, TEST_USER_PASSWORDS[EDITOR_EMAIL]!);
    const drafts = await Promise.all(Array.from({ length: 20 }, () => createPublishableRelease(cookie)));
    const approved = await Promise.all(drafts.map((d) => approveRelease(cookie, d)));

    const keys = approved.map((a) => a.key);
    const references = approved.map((a) => a.reference);

    expect(new Set(keys).size).toBe(20);
    expect(new Set(references).size).toBe(20);
    for (const k of keys) expect(k).toMatch(/^\d{4}HLTH\d{4}-\d{6}$/);
    for (const r of references) expect(r).toMatch(/^NEWS-\d{5}$/);
  });
});

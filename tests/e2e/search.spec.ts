// Acceptance item 11: "Search finds headline text, NEWS- numbers, keys and Calendar ids,
// drafts included."
import { test, expect } from "@playwright/test";
import { EDITOR_EMAIL, TEST_USER_PASSWORDS } from "./constants";
import { apiCall, approveRelease, baseUrl, createPublishableRelease, loginForCookie, signInAs, uniqueHeadline } from "./playwright-support";
import type { ReleaseView } from "@gcpe/nrms-contract";

test.describe("item 11: search", () => {
  test("finds a draft by headline text, NEWS- reference, key, and Calendar activity id", async ({ page, context }) => {
    const cookie = await loginForCookie(EDITOR_EMAIL, TEST_USER_PASSWORDS[EDITOR_EMAIL]!);
    const headline = uniqueHeadline("Searchable clinic expansion announcement");
    const created = await createPublishableRelease(cookie, { headline });
    const approved = await approveRelease(cookie, created); // approved, never scheduled — still a draft
    const activityId = 424242;
    const withActivity = await apiCall<ReleaseView>(cookie, `/nrms/api/releases/${approved.id}/settings`, {
      method: "PUT",
      body: { version: approved.version, activityId, toSubscribers: false, toMediaLists: false, mediaListKeys: [] },
    });
    expect(withActivity.status).toBe("approved"); // still in Drafts, never published

    await signInAs(context, "editor");

    // 1. Headline text.
    await page.goto(`${baseUrl()}/hub/search`);
    await page.getByLabel("Search").fill("Searchable clinic expansion");
    await page.getByRole("button", { name: "Search" }).click();
    await expect(page.getByRole("link", { name: headline })).toBeVisible();

    // 2. NEWS- reference — the fast /goto path navigates straight to the release.
    await page.goto(`${baseUrl()}/hub/search`);
    await page.getByLabel("Search").fill(withActivity.reference!);
    await page.getByRole("button", { name: "Search" }).click();
    await expect(page).toHaveURL(new RegExp(`/hub/releases/${withActivity.id}$`));

    // 3. Exact key.
    await page.goto(`${baseUrl()}/hub/search`);
    await page.getByLabel("Search").fill(withActivity.key!);
    await page.getByRole("button", { name: "Search" }).click();
    await expect(page).toHaveURL(new RegExp(`/hub/releases/${withActivity.id}$`));

    // 4. Calendar activity id ("<letters>-<digits>", apps/nrms/src/releases/queries.ts's
    // ACTIVITY_QUERY) — falls through to the full search, which still includes drafts.
    await page.goto(`${baseUrl()}/hub/search`);
    await page.getByLabel("Search").fill(`CAL-${activityId}`);
    await page.getByRole("button", { name: "Search" }).click();
    await expect(page.getByRole("link", { name: headline })).toBeVisible();
    await expect(page.getByText(`Calendar activity ${activityId}`)).toBeVisible();
  });
});

// Acceptance item 13: "Top/Feature: taking a slot moves the previous release out; 'What's
// featured where' reflects it."
import { test, expect } from "@playwright/test";
import { EDITOR_EMAIL, TEST_USER_PASSWORDS } from "./constants";
import { apiCall, baseUrl, createApprovedAndPublished, loginForCookie, signInAs, uniqueHeadline } from "./playwright-support";
import type { ReleaseView } from "@gcpe/nrms-contract";

test.describe("item 13: Top/Feature switches", () => {
  test("putting a second release in Home/Top moves the first one out, reflected in What's featured where", async ({ page, context }) => {
    const cookie = await loginForCookie(EDITOR_EMAIL, TEST_USER_PASSWORDS[EDITOR_EMAIL]!);
    const headlineA = uniqueHeadline("Featured first release");
    const headlineB = uniqueHeadline("Featured second release");
    const releaseA = await createApprovedAndPublished(cookie, { headline: headlineA });
    const releaseB = await createApprovedAndPublished(cookie, { headline: headlineB });

    await signInAs(context, "editor");
    await page.goto(`${baseUrl()}/hub/releases/${releaseA.id}`);
    const categoriesA = page.getByRole("region", { name: "Categories" });
    await categoriesA.getByRole("group", { name: "Home" }).getByRole("switch", { name: "Top" }).click({ force: true });
    await expect(categoriesA.getByRole("group", { name: "Home" }).getByRole("switch", { name: "Top" })).toBeChecked();

    // Release B takes the same slot, directly against the API.
    await apiCall(cookie, "/nrms/api/releases/" + releaseB.id + "/features", { method: "POST", body: { kind: "home", key: "default", slot: "top", on: true } });

    const afterA = await apiCall<ReleaseView>(cookie, `/nrms/api/releases/${releaseA.id}`);
    expect(afterA.features.some((f) => f.kind === "home" && f.slot === "top")).toBe(false);
    const afterB = await apiCall<ReleaseView>(cookie, `/nrms/api/releases/${releaseB.id}`);
    expect(afterB.features.some((f) => f.kind === "home" && f.slot === "top")).toBe(true);

    // FeaturedScreen is read-only for every role, but WebsiteScreen's own shell (the parent
    // route) still gates all of /hub/website/* to NRMS.SiteEditor or Core.Admin — an editor
    // alone can't reach it.
    await signInAs(context, "admin");
    await page.goto(`${baseUrl()}/hub/website/featured`);
    const homeHeader = page.getByRole("rowheader", { name: "Home" });
    await expect(homeHeader).toBeVisible();
    const row = page.locator("tr").filter({ has: page.getByRole("rowheader", { name: "Home" }) });
    await expect(row).toHaveCount(1);
    await expect(row).toContainText(headlineB);
    await expect(row).not.toContainText(headlineA);
  });
});

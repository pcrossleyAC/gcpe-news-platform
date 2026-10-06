// Acceptance item 1 (docs/superpowers/specs/2026-10-03-nrms-parity-design.md §9): "Test editor
// signs in; viewer can read but not change; site editor reaches the Website section but cannot
// Approve." Also covers axe on the sign-in screen (item 16).
import { test, expect } from "@playwright/test";
import { EDITOR_EMAIL, TEST_USER_PASSWORDS } from "./constants";
import { apiCall, baseUrl, createApprovedAndPublished, createPublishableRelease, expectNoSeriousA11yViolations, loginForCookie, ROLE_LOGINS, signInAs, uniqueHeadline } from "./playwright-support";

test.describe("item 1: sign-in and role visibility", () => {
  test("a test editor signs in through the sign-in form and lands on Drafts", async ({ page }) => {
    await page.goto(`${baseUrl()}/hub/sign-in`);
    await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
    await expectNoSeriousA11yViolations(page, "sign-in screen");

    await page.getByLabel("User name").fill(EDITOR_EMAIL);
    await page.getByLabel("Password").fill(TEST_USER_PASSWORDS[EDITOR_EMAIL]!);
    await page.getByRole("button", { name: "Sign in" }).click();

    await expect(page).toHaveURL(/\/hub\/releases\/drafts$/);
    await expect(page.getByText("Signed in as Test Editor")).toBeVisible();
    // Editors get the create-release link.
    await expect(page.getByRole("link", { name: "New release" })).toBeVisible();
  });

  test("a wrong password shows the sign-in-failed message, not a generic error", async ({ page }) => {
    await page.goto(`${baseUrl()}/hub/sign-in`);
    await page.getByLabel("User name").fill(EDITOR_EMAIL);
    await page.getByLabel("Password").fill("definitely-the-wrong-password");
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.getByRole("alert")).toHaveText("Sign-in failed. Check your user name and password.");
  });

  test("a viewer can read a release but has no write controls anywhere", async ({ page, context }) => {
    await signInAs(context, "viewer");
    await page.goto(`${baseUrl()}/hub/releases/drafts`);
    await expect(page.getByRole("heading", { name: "Releases" })).toBeVisible();
    // No create-release link for a Viewer.
    await expect(page.getByRole("link", { name: "New release" })).toHaveCount(0);
    // Minors: every read role (including Viewer) now reaches Website, but only for the
    // read-only Featured/Log sections — Users and the error log stay Core.Admin only
    // (AppShell.tsx's NAV_ITEMS).
    await expect(page.getByRole("link", { name: "Website" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Users" })).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Error log" })).toHaveCount(0);
    await page.getByRole("link", { name: "Website" }).click();
    await expect(page.getByRole("link", { name: "What's featured where" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Carousel" })).toHaveCount(0);
    await page.goto(`${baseUrl()}/hub/releases/drafts`);

    const editorCookie = await loginForCookie(EDITOR_EMAIL, TEST_USER_PASSWORDS[EDITOR_EMAIL]!);
    const headline = uniqueHeadline("Viewer read-only release");
    const view = await createApprovedAndPublished(editorCookie, { headline });
    await page.goto(`${baseUrl()}/hub/releases/${view.id}`);
    await expect(page.getByRole("heading", { level: 1 })).toContainText(headline);
    // No Actions section (Approve/Publish/Delete/...) for a Viewer at all.
    await expect(page.getByRole("region", { name: "Actions" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Approve" })).toHaveCount(0);
    // Every form field on the page is disabled for a read-only Viewer.
    const urlKeyField = page.getByLabel("URL key");
    await expect(urlKeyField).toBeDisabled();
  });

  test("a site editor reaches the Website section but never sees Approve", async ({ page, context }) => {
    await signInAs(context, "siteEditor");
    await page.goto(`${baseUrl()}/hub/releases/drafts`);
    await expect(page.getByRole("link", { name: "Website" })).toBeVisible();
    await expect(page.getByRole("link", { name: "New release" })).toHaveCount(0);

    await page.getByRole("link", { name: "Website" }).click();
    await expect(page).toHaveURL(/\/hub\/website\/carousel$/);
    await expect(page.getByRole("heading", { name: "Carousel" })).toBeVisible();

    // I6: a published release's Approve/Publish buttons are absent for *every* role (they're
    // actions for a draft/approved release, not a published one) — that alone proves nothing
    // about the site editor's own role gate. Use a draft instead: the whole Actions region
    // (not just one button) must be absent for a site editor, and the server itself (not just
    // the UI) must refuse the write.
    const editorCookie = await loginForCookie(EDITOR_EMAIL, TEST_USER_PASSWORDS[EDITOR_EMAIL]!);
    const headline = uniqueHeadline("Site editor sees no Actions");
    const draft = await createPublishableRelease(editorCookie, { headline });
    await page.goto(`${baseUrl()}/hub/releases/${draft.id}`);
    await expect(page.getByRole("heading", { level: 1 })).toContainText(headline);
    await expect(page.getByRole("region", { name: "Actions" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Approve" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Publish now" })).toHaveCount(0);

    const siteEditorCookie = await ROLE_LOGINS.siteEditor();
    await expect(apiCall(siteEditorCookie, `/nrms/api/releases/${draft.id}/approve`, { method: "POST", body: { version: draft.version } })).rejects.toThrow("403");

    // Site editor is also never offered Blue Bridge's switch, Users, or the error log.
    await page.goto(`${baseUrl()}/hub/website/blue-bridge`);
    await expect(page.getByRole("switch", { name: "Project Blue Bridge" })).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Users" })).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Error log" })).toHaveCount(0);
  });

  test("Core.Admin (break-glass) sees Users, Error log and Blue Bridge's switch", async ({ page, context }) => {
    await signInAs(context, "admin");
    await page.goto(`${baseUrl()}/hub/releases/drafts`);
    await expect(page.getByRole("link", { name: "Users" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Error log" })).toBeVisible();
    await page.goto(`${baseUrl()}/hub/website/blue-bridge`);
    await expect(page.getByRole("switch", { name: "Project Blue Bridge" })).toBeVisible();
  });
});

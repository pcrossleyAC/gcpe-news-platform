// Acceptance item 16: "Every staff screen passes axe with no serious or critical violations."
// task-6-brief.md: axe (wcag2a/wcag2aa/wcag21aa/wcag22aa tags) on every screen and every
// dialog — sign-in, Drafts/Scheduled/Published, search, new release, the editor (incl.
// documents/side bar and the delete dialog, with a real focus-trap/inert check), every Website
// screen (incl. Blue Bridge's dialog), Users, the error log.
import { test, expect } from "@playwright/test";
import { EDITOR_EMAIL, TEST_USER_PASSWORDS } from "./constants";
import { baseUrl, createApprovedAndPublished, createPublishableRelease, expectNoSeriousA11yViolations, loginForCookie, settleModalTransition, signInAs } from "./playwright-support";

test.describe("item 16: axe across every staff screen", () => {
  test("sign-in", async ({ page }) => {
    await page.goto(`${baseUrl()}/hub/sign-in`);
    await expectNoSeriousA11yViolations(page, "sign-in");
  });

  test("Drafts / Scheduled / Published, Search, New release", async ({ page, context }) => {
    await signInAs(context, "editor");
    for (const path of ["/hub/releases/drafts", "/hub/releases/scheduled", "/hub/releases/published", "/hub/search", "/hub/releases/new"]) {
      await page.goto(`${baseUrl()}${path}`);
      await expectNoSeriousA11yViolations(page, path);
    }
  });

  test("the release editor, including Documents/side bar and a real focus-trapped, inert-background delete dialog", async ({ page, context }) => {
    const cookie = await loginForCookie(EDITOR_EMAIL, TEST_USER_PASSWORDS[EDITOR_EMAIL]!);
    const published = await createApprovedAndPublished(cookie);
    await signInAs(context, "editor");
    await page.goto(`${baseUrl()}/hub/releases/${published.id}`);
    await expect(page.getByRole("region", { name: "Documents" })).toBeVisible();
    await expect(page.getByRole("complementary", { name: "Release info" })).toBeVisible();
    await expectNoSeriousA11yViolations(page, "release editor");

    // A published release has no Delete button (not in DELETABLE_STATUSES) — create a plain
    // draft instead, which does.
    const draft = await createPublishableRelease(cookie);
    await page.goto(`${baseUrl()}/hub/releases/${draft.id}`);
    const deleteButton = page.getByRole("button", { name: "Delete" });
    await deleteButton.click();

    // Not matched by name: DialogTrigger's dialog computes its accessible name from the
    // trigger button ("Delete"), not the AlertDialog's own `title` ("Delete this release?",
    // shown as visible heading text) — a one-dialog-open-at-a-time page doesn't need the name
    // filter anyway.
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText("Delete this release?")).toBeVisible();
    await settleModalTransition(page);
    await expectNoSeriousA11yViolations(page, "release editor: delete dialog open");

    // Focus moved into the dialog (minors.md: React Aria's focus-restore work happens in a
    // requestAnimationFrame — give it a beat).
    await expect.poll(async () => page.evaluate(() => document.activeElement?.closest('[role="dialog"]') !== null)).toBe(true);

    // The background is genuinely `inert` (not merely aria-hidden) — minors.md: jsdom can't
    // express this, so it's checked here, in a real browser, for the first time. The Modal is
    // portalled to a sibling of #root (document.body's other top-level child), and `inert` is
    // set there — it isn't its own attribute on every descendant, but every descendant (e.g.
    // .gcpe-shell__main) is still effectively inert by inheritance.
    const rootIsInert = await page.evaluate(() => (document.getElementById("root") as HTMLElement | null)?.inert ?? false);
    expect(rootIsInert).toBe(true);

    await page.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toBeHidden();
    // Focus restored to the trigger that opened it (same requestAnimationFrame caveat).
    await expect.poll(async () => page.evaluate(() => document.activeElement?.textContent?.trim())).toBe("Delete");
  });

  test("every Website screen, including Blue Bridge's confirmation dialog", async ({ page, context }) => {
    await signInAs(context, "siteEditor");
    for (const path of ["/hub/website/carousel", "/hub/website/pins", "/hub/website/live-feed", "/hub/website/links", "/hub/website/files", "/hub/website/featured", "/hub/website/log"]) {
      await page.goto(`${baseUrl()}${path}`);
      await expectNoSeriousA11yViolations(page, path);
    }

    await signInAs(context, "admin");
    await page.goto(`${baseUrl()}/hub/website/blue-bridge`);
    await expectNoSeriousA11yViolations(page, "/hub/website/blue-bridge");
    await page.getByRole("switch", { name: "Project Blue Bridge" }).click({ force: true });
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await settleModalTransition(page);
    await expectNoSeriousA11yViolations(page, "/hub/website/blue-bridge: confirmation dialog open");
    await page.getByRole("button", { name: "Cancel" }).click();
  });

  test("Users and the Error log", async ({ page, context }) => {
    await signInAs(context, "admin");
    await page.goto(`${baseUrl()}/hub/users`);
    await expectNoSeriousA11yViolations(page, "/hub/users");
    await page.goto(`${baseUrl()}/hub/error-log`);
    await expectNoSeriousA11yViolations(page, "/hub/error-log");
  });
});

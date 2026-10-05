// Acceptance item 2: "Each creatable type (Release, Story, Factsheet, Advisory) enforces
// legacy's per-type required fields in the form; the API refuses the same input directly."
import { test, expect } from "@playwright/test";
import { CREATABLE_TYPES, TYPE_LABEL } from "@gcpe/nrms-contract";
import { EDITOR_EMAIL, TEST_USER_PASSWORDS } from "./constants";
import { apiCall, approveRelease, baseUrl, createPublishableRelease, expectNoSeriousA11yViolations, loginForCookie, signInAs, uniqueHeadline } from "./playwright-support";

test.describe("item 2: per-type required/allowed fields", () => {
  test("the new-release form requires a headline before it will submit", async ({ page, context }) => {
    await signInAs(context, "editor");
    await page.goto(`${baseUrl()}/hub/releases/new`);
    await expect(page.getByRole("heading", { name: "New release" })).toBeVisible();
    await expectNoSeriousA11yViolations(page, "new-release screen");

    // Page title is itself required by the schema — select one so the only missing field left
    // is the headline, keeping this assertion about exactly that one problem.
    await page.getByLabel("Page title").selectOption({ label: "News Release" });
    await page.getByRole("button", { name: "Create release" }).click();
    // createReleaseSchema requires a non-empty headline; the client validates before any
    // request is sent, so the form stays on the same page with the problem shown.
    await expect(page).toHaveURL(/\/hub\/releases\/new$/);
    await expect(page.getByLabel("Headline")).toHaveAttribute("aria-invalid", "true");
  });

  test("the API refuses the same missing-headline input directly, with a 400", async () => {
    const cookie = await loginForCookie(EDITOR_EMAIL, TEST_USER_PASSWORDS[EDITOR_EMAIL]!);
    await expect(
      apiCall(cookie, "/nrms/api/releases", {
        method: "POST",
        body: { type: "release", pageTitle: "News Release", layout: "formal", pageImageId: null, headline: "", ministries: ["health"], leadMinistryKey: "health", sectors: ["health"] },
      }),
    ).rejects.toThrow(/400/);
  });

  test("Advisory offers no Sectors/Themes/Tags/page-image fields in the form", async ({ page, context }) => {
    await signInAs(context, "editor");
    await page.goto(`${baseUrl()}/hub/releases/new`);
    await page.getByLabel("Type").selectOption("advisory");
    await expect(page.getByRole("group", { name: "Sectors" })).toHaveCount(0);
    await expect(page.getByRole("group", { name: "Themes" })).toHaveCount(0);
    await expect(page.getByRole("group", { name: "Tags" })).toHaveCount(0);
    await expect(page.getByRole("group", { name: "Page image" })).toHaveCount(0);
    // But Media distribution lists is offered (and marked required for an Advisory).
    await expect(page.getByText("Media distribution lists (required)")).toBeVisible();
  });

  test("the API refuses an Advisory with sectors attached, directly", async () => {
    const cookie = await loginForCookie(EDITOR_EMAIL, TEST_USER_PASSWORDS[EDITOR_EMAIL]!);
    await expect(
      apiCall(cookie, "/nrms/api/releases", {
        method: "POST",
        body: {
          type: "advisory", pageTitle: "Media Advisory", layout: "formal", pageImageId: null,
          headline: uniqueHeadline("Advisory with sectors"), ministries: ["health"], leadMinistryKey: "health",
          sectors: ["health"], mediaListKeys: ["regional"],
        },
      }),
    ).rejects.toThrow(/422/);
  });

  // I6: an Advisory's only distribution channel is media lists (it can't go to NoD
  // subscribers) — the server refuses to schedule/publish one with none at all, and the form
  // must show the editor why, not just silently leave Publish disabled.
  test("an Advisory with no media lists: the API refuses to publish it (422), and the form shows why", async ({ page, context }) => {
    const cookie = await loginForCookie(EDITOR_EMAIL, TEST_USER_PASSWORDS[EDITOR_EMAIL]!);
    const created = await createPublishableRelease(cookie, {
      type: "advisory", sectors: [], themes: [], tags: [], mediaListKeys: [], headline: uniqueHeadline("Advisory with no media lists"),
    });
    const approved = await approveRelease(cookie, created);

    await expect(
      apiCall(cookie, `/nrms/api/releases/${approved.id}/schedule`, { method: "POST", body: { version: approved.version, publishAt: "now" } }),
    ).rejects.toThrow(/422/);

    await signInAs(context, "editor");
    await page.goto(`${baseUrl()}/hub/releases/${approved.id}`);
    await expect(page.getByText("Choose at least one media distribution list.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Publish now" })).toBeDisabled();

    // Fixable from the same form: check a media list, save, and the warning (and the
    // disabled state) must clear.
    const settings = page.getByRole("region", { name: "Publish settings" });
    await settings.getByRole("checkbox", { name: /Regional media/ }).check();
    await Promise.all([
      page.waitForResponse((r) => r.request().method() === "PUT" && r.url().includes("/settings")),
      settings.getByRole("button", { name: "Save settings" }).click(),
    ]);
    await expect(page.getByText("Choose at least one media distribution list.")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Publish now" })).toBeEnabled();
  });

  const PAGE_TITLE_FOR: Record<string, string> = { release: "News Release", story: "News Story", factsheet: "Fact Sheet", advisory: "Media Advisory" };

  for (const type of CREATABLE_TYPES) {
    test(`a minimal ${type} can be created through the form`, async ({ page, context }) => {
      await signInAs(context, "editor");
      await page.goto(`${baseUrl()}/hub/releases/new`);
      await page.getByLabel("Type").selectOption(type);
      await page.getByLabel("Page title").selectOption({ label: PAGE_TITLE_FOR[type]! });
      await page.getByLabel("Headline").fill(uniqueHeadline(`Minimal ${TYPE_LABEL[type]}`));
      await page.getByRole("checkbox", { name: "Health" }).first().check();
      if (type === "advisory") {
        await page.getByRole("checkbox", { name: /Regional media/ }).check();
      }
      await page.getByRole("button", { name: "Create release" }).click();
      await expect(page).toHaveURL(/\/hub\/releases\/[0-9a-f-]+$/);
    });
  }
});

// Acceptance item 3: "Two documents in English and French with contacts; drag reorder; summary
// auto-fills until hand-edited."
import { test, expect, type Locator, type Page } from "@playwright/test";
import { EDITOR_EMAIL, TEST_USER_PASSWORDS } from "./constants";
import { baseUrl, createPublishableRelease, dragReorder, loginForCookie, signInAs } from "./playwright-support";

/**
 * Clicks a button that triggers a PUT/POST save and waits for that save's response before
 * returning. Plain `.click()` only waits for the click event to dispatch, not for the fetch it
 * triggers — back-to-back saves on the same release (every write here bumps `version`) would
 * otherwise race: a second save built from a not-yet-updated `view.version` lands on the server
 * as a stale version and gets a 409, exactly like two real editors colliding.
 */
async function clickAndWaitForSave(page: Page, button: Locator): Promise<void> {
  await Promise.all([
    page.waitForResponse((r) => r.request().method() !== "GET" && r.url().includes("/nrms/api/releases/")),
    button.click(),
  ]);
}

test.describe("item 3: documents, translations, contacts, reorder, auto-summary", () => {
  test("two documents with EN+FR content and contacts; reorder; summary auto-fills until hand-edited", async ({ page, context }) => {
    const editorCookie = await loginForCookie(EDITOR_EMAIL, TEST_USER_PASSWORDS[EDITOR_EMAIL]!);
    const view = await createPublishableRelease(editorCookie);
    await signInAs(context, "editor");
    await page.goto(`${baseUrl()}/hub/releases/${view.id}`);

    const docsSection = page.getByRole("region", { name: "Documents" });
    const firstItem = docsSection.locator(".gcpe-documents__item").nth(0);

    // The release was created with a body already — summaryFromBody fills the summary and
    // summaryEdited starts false, so the Documents section shows the "(auto)" marker.
    await expect(docsSection.locator(".gcpe-documents__summary-note")).toContainText("(auto)");
    const initialSummary = (await docsSection.locator(".gcpe-documents__summary-note").textContent())!;

    // Edit document 1's English body — the summary should auto-update (still unedited).
    const newBody = "A brand new body paragraph about weekend clinics expanding province-wide.";
    const englishBody = firstItem.getByRole("textbox", { name: "Body" });
    await englishBody.click();
    await expect(englishBody).toBeFocused();
    await page.keyboard.press("ControlOrMeta+A");
    await page.keyboard.press("Backspace");
    await page.keyboard.type(newBody);
    await expect(englishBody).toContainText(newBody);
    await clickAndWaitForSave(page, firstItem.getByRole("button", { name: /Save English content/ }));
    await expect(docsSection.locator(".gcpe-documents__summary-note")).toContainText("(auto)");
    await expect
      .poll(async () => docsSection.locator(".gcpe-documents__summary-note").textContent())
      .not.toBe(initialSummary);

    // Add a contact to document 1's English content.
    await firstItem.getByRole("button", { name: "Add contact" }).click();
    await firstItem.getByLabel("Contact 1").fill("Media Relations\nMinistry of Health\n250-555-0101");
    await clickAndWaitForSave(page, firstItem.getByRole("button", { name: /Save English content/ }));
    await expect(firstItem.getByLabel("Contact 1")).toHaveValue("Media Relations\nMinistry of Health\n250-555-0101");

    // Add a French translation to document 1, with its own content and a contact.
    await clickAndWaitForSave(page, firstItem.getByRole("button", { name: "Add French translation" }));
    await expect(firstItem.getByRole("tab", { name: "French" })).toHaveAttribute("aria-selected", "true");
    await firstItem.getByLabel("Page title").fill("Communiqué de presse");
    await firstItem.getByLabel("Headline", { exact: true }).fill("Des cliniques ouvertes les week-ends");
    await firstItem.getByLabel("Organizations").fill("Ministère de la Santé");
    const frenchBodyText = "Les cliniques seront ouvertes les week-ends à partir de novembre.";
    const frenchBody = firstItem.getByRole("textbox", { name: "Body" });
    await frenchBody.click();
    await expect(frenchBody).toBeFocused();
    await page.keyboard.type(frenchBodyText);
    await expect(frenchBody).toContainText(frenchBodyText);
    await firstItem.getByRole("button", { name: "Add contact" }).click();
    await firstItem.getByLabel("Contact 1").fill("Relations avec les médias\n250-555-0101");
    await clickAndWaitForSave(page, firstItem.getByRole("button", { name: /Save French content/ }));
    await expect(firstItem.getByLabel("Contact 1")).toHaveValue("Relations avec les médias\n250-555-0101");

    // Hand-edit the summary (Page details section) — this should flip summaryEdited.
    const pageDetails = page.getByRole("region", { name: "Page details" });
    const customSummary = `Hand-written summary ${Date.now()}`;
    await pageDetails.getByLabel("Summary", { exact: true }).fill(customSummary);
    await clickAndWaitForSave(page, pageDetails.getByRole("button", { name: "Save page details" }));
    await expect(docsSection.locator(".gcpe-documents__summary-note")).not.toContainText("(auto)");
    await expect(docsSection.locator(".gcpe-documents__summary-note")).toContainText(customSummary);

    // A further body edit must no longer overwrite the hand-edited summary.
    await firstItem.getByRole("tab", { name: "English" }).click();
    const laterBodyText = "Yet another body change that must not touch the summary any more.";
    const laterBody = firstItem.getByRole("textbox", { name: "Body" });
    await laterBody.click();
    await expect(laterBody).toBeFocused();
    await page.keyboard.press("ControlOrMeta+A");
    await page.keyboard.press("Backspace");
    await page.keyboard.type(laterBodyText);
    await expect(laterBody).toContainText(laterBodyText);
    await clickAndWaitForSave(page, firstItem.getByRole("button", { name: /Save English content/ }));
    await expect(docsSection.locator(".gcpe-documents__summary-note")).toContainText(customSummary);
    await expect(docsSection.locator(".gcpe-documents__summary-note")).not.toContainText("(auto)");

    // Add a second document.
    await docsSection.getByRole("button", { name: "Add document" }).click();
    const addForm = docsSection.getByRole("form", { name: "Add document" });
    await addForm.getByLabel("Page title").fill("Second Document Page Title");
    await clickAndWaitForSave(page, addForm.getByRole("button", { name: "Add", exact: true }));
    await expect(docsSection.locator(".gcpe-documents__item")).toHaveCount(2);

    const pageTitleOf = (index: number) => docsSection.locator(".gcpe-documents__item").nth(index).getByLabel("Page title");
    // Document 1's active tab is English again (switched above) — "News Release" is its
    // English page title; document 2 is the one just added.
    await expect(pageTitleOf(0)).toHaveValue("News Release");
    await expect(pageTitleOf(1)).toHaveValue("Second Document Page Title");

    // Reorder with the keyboard-operable Move down button (constraints.md: every drag-reorder
    // needs a keyboard alternative) — moves document 1 (News Release) below document 2.
    await clickAndWaitForSave(page, docsSection.getByRole("button", { name: "Move document 1 down" }));
    await expect.poll(() => pageTitleOf(0).inputValue()).toBe("Second Document Page Title");
    await expect(pageTitleOf(1)).toHaveValue("News Release");

    // And back up again, by raw HTML5 drag-and-drop on the now-first item onto the second —
    // the same onDragStart/onDragOver/onDrop handlers the Move buttons drive, dispatched by
    // hand (not Playwright's `dragTo`, which drives pointer events only: Chromium's native
    // HTML5 drag protocol needs its own drag/dataTransfer events, which `dragTo` doesn't raise
    // — confirmed by running it here and watching the drop have no effect).
    const items = docsSection.locator(".gcpe-documents__item");
    // I3: only the dedicated grip handle is draggable now (the whole row no longer is, so
    // text in its inputs can be mouse-selected) — dragstart must originate there, not on the
    // row itself.
    await Promise.all([
      page.waitForResponse((r) => r.request().method() !== "GET" && r.url().includes("/nrms/api/releases/")),
      dragReorder(page, items.nth(1).locator(".gcpe-drag-handle"), items.nth(0)),
    ]);
    await expect.poll(() => pageTitleOf(0).inputValue()).toBe("News Release");

    // I6 (item 3): reload the page and assert everything actually persisted server-side —
    // the two documents (in their post-reorder order), document 1's French translation, and
    // both documents' contacts — not just what the in-memory React state happened to show
    // right after each save.
    await page.reload();
    await expect(docsSection.locator(".gcpe-documents__item")).toHaveCount(2);
    await expect(pageTitleOf(0)).toHaveValue("News Release");
    await expect(pageTitleOf(1)).toHaveValue("Second Document Page Title");

    const reloadedFirstItem = docsSection.locator(".gcpe-documents__item").nth(0);
    await expect(reloadedFirstItem.getByRole("tab", { name: "French" })).toBeVisible();
    await reloadedFirstItem.getByRole("tab", { name: "English" }).click();
    await expect(reloadedFirstItem.getByLabel("Contact 1")).toHaveValue("Media Relations\nMinistry of Health\n250-555-0101");
    await reloadedFirstItem.getByRole("tab", { name: "French" }).click();
    await expect(reloadedFirstItem.getByLabel("Page title")).toHaveValue("Communiqué de presse");
    await expect(reloadedFirstItem.getByLabel("Headline", { exact: true })).toHaveValue("Des cliniques ouvertes les week-ends");
    await expect(reloadedFirstItem.getByLabel("Contact 1")).toHaveValue("Relations avec les médias\n250-555-0101");
  });
});

// Hand-check feedback on boxs.ca: a long document body pushed the document's own Save button
// out of view — the sticky save bar (fixed to the bottom of the viewport) is always reachable.
test.describe("sticky save bar", () => {
  test("typing in a document body shows the bar; its own Save button persists the change after reload", async ({ page, context }) => {
    const editorCookie = await loginForCookie(EDITOR_EMAIL, TEST_USER_PASSWORDS[EDITOR_EMAIL]!);
    const view = await createPublishableRelease(editorCookie);
    await signInAs(context, "editor");
    await page.goto(`${baseUrl()}/hub/releases/${view.id}`);

    const bar = page.getByRole("region", { name: "Unsaved changes" });
    await expect(bar).not.toBeVisible();

    const docsSection = page.getByRole("region", { name: "Documents" });
    const firstItem = docsSection.locator(".gcpe-documents__item").nth(0);
    const body = firstItem.getByRole("textbox", { name: "Body" });
    const addedText = `Sticky bar check ${Date.now()}`;
    await body.click();
    await page.keyboard.press("End");
    await page.keyboard.type(` ${addedText}`);
    await expect(body).toContainText(addedText);

    await expect(bar).toBeVisible();
    await expect(bar).toContainText("English content (Document 1)");
    const barSaveButton = bar.getByRole("button", { name: /Save English content/ });

    await clickAndWaitForSave(page, barSaveButton);
    await expect(bar).not.toBeVisible();

    await page.reload();
    const reloadedBody = docsSection.locator(".gcpe-documents__item").nth(0).getByRole("textbox", { name: "Body" });
    await expect(reloadedBody).toContainText(addedText);
  });
});

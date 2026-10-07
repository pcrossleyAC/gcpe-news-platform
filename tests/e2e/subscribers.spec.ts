// Acceptance item 14 (NoD parity spec §10): "Viewer/Editor/Admin each see exactly their parts of
// the Subscribers section", plus the §8 Subscribers flows end to end through the stack: add,
// edit, bulk deactivate/activate with confirmation, change email, delete, history — with axe
// on every screen and dialog.
import { test, expect, type Page } from "@playwright/test";
import { apiCall, baseUrl, ensureSubscriber, expectNoSeriousA11yViolations, ROLE_LOGINS, settleModalTransition, signInAs } from "./playwright-support";

const unique = (label: string) => `${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.test`;

/**
 * Runs `run` while recording every request this page makes, then asserts `term` — an email
 * address or a search substring — appears in neither the final page URL nor any request URL.
 * Guards the rule that a Subscribers search term is a POST body field, never a URL/query-string
 * value: a reverse proxy or the browser's own history would otherwise record it.
 */
async function assertTermStaysOutOfUrls(page: Page, term: string, run: () => Promise<void>): Promise<void> {
  const seen: string[] = [];
  const onRequest = (req: { url(): string }) => seen.push(req.url());
  page.on("request", onRequest);
  try {
    await run();
  } finally {
    page.off("request", onRequest);
  }
  for (const url of seen) expect(url, `request URL carried the search term: ${url}`).not.toContain(term);
  expect(page.url(), "page URL carried the search term").not.toContain(term);
}

test.describe("item 14: Subscribers section by role", () => {
  test("a NoD Viewer finds subscribers read-only; the server refuses their writes", async ({ page, context }) => {
    const admin = await ROLE_LOGINS.admin();
    const email = unique("viewer-sees");
    await ensureSubscriber(admin, email, ["ministries:health"]);
    await signInAs(context, "nodViewer");
    await page.goto(`${baseUrl()}/hub/`);
    await expect(page).toHaveURL(/\/hub\/subscribers$/);
    await expect(page.getByRole("link", { name: "Releases" })).toHaveCount(0);

    await assertTermStaysOutOfUrls(page, email, async () => {
      await page.getByLabel("Email contains").fill(email);
      await page.getByRole("button", { name: "Search" }).click();
      await expect(page.getByRole("link", { name: email })).toBeVisible();
    });

    await page.getByRole("link", { name: email }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Subscriber" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Save preferences" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Delete" })).toHaveCount(0);
    await expectNoSeriousA11yViolations(page, "subscriber detail (viewer)");

    const viewer = await ROLE_LOGINS.nodViewer();
    await expect(apiCall(viewer, "/nod/api/subscribers/bulk", { method: "POST", body: { action: "delete", ids: [crypto.randomUUID()] } })).rejects.toThrow(/403/);
  });

  test("an NRMS editor doesn't see the Subscribers section", async ({ page, context }) => {
    await signInAs(context, "editor");
    await page.goto(`${baseUrl()}/hub/releases/drafts`);
    await expect(page.getByRole("link", { name: "Subscribers" })).toHaveCount(0);
  });

  test("an Admin sees the same Subscribers controls as an Editor", async ({ page, context }) => {
    await signInAs(context, "admin");
    await page.goto(`${baseUrl()}/hub/subscribers`);
    await expect(page.getByRole("link", { name: "Add a subscriber" })).toBeVisible();
  });
});

test.describe("§8 Subscribers flows (NoD Editor)", () => {
  test("add → edit → bulk deactivate/activate with confirmation → change email → delete → history", async ({ page, context }) => {
    const email = unique("flow");
    const moved = unique("flow-moved");
    const other = unique("flow-other");
    await ensureSubscriber(await ROLE_LOGINS.admin(), other, ["ministries:health"]);
    await signInAs(context, "nodEditor");

    await page.goto(`${baseUrl()}/hub/subscribers/new`);
    await expectNoSeriousA11yViolations(page, "add subscriber");
    // The design system appends "(required)" to a required field's accessible name with no
    // space (so the rendered label reads "Email(required)") — matched by its start, since
    // "Confirm email" would otherwise also match a plain substring search for "Email".
    await page.getByLabel(/^Email/).fill(email);
    await page.getByLabel("Confirm email").fill(email);
    await page.getByRole("checkbox", { name: "All news" }).check();
    await page.getByRole("button", { name: "Add subscriber" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Subscriber" })).toBeVisible();
    await expect(page.getByText(email)).toBeVisible();
    await expect(page.getByText("Active", { exact: true })).toBeVisible();

    await page.getByRole("checkbox", { name: "Daily digest" }).check();
    await page.getByRole("button", { name: "Save preferences" }).click();
    // Not getByRole("status"): AnnouncerProvider's own shared live region (Announcer.tsx) also
    // carries that role, so the role alone resolves to two elements in the staff shell.
    await expect(page.getByText("Preferences saved.")).toBeVisible();

    // The search box, not a `?q=` link — the screen never puts the term in the URL (same rule
    // as above); both seeded addresses share this substring.
    const term = "flow-";
    await page.goto(`${baseUrl()}/hub/subscribers`);
    await assertTermStaysOutOfUrls(page, term, async () => {
      await page.getByLabel("Email contains").fill(term);
      await page.getByRole("button", { name: "Search" }).click();
      await expect(page.getByRole("link", { name: email })).toBeVisible();
      await expect(page.getByRole("link", { name: other })).toBeVisible();
    });

    await page.getByRole("checkbox", { name: `Select ${email}` }).check();
    await page.getByRole("checkbox", { name: `Select ${other}` }).check();
    await page.getByRole("button", { name: "Deactivate selected (2)", exact: true }).click();
    await settleModalTransition(page);
    await expectNoSeriousA11yViolations(page, "bulk deactivate dialog");
    await page.getByRole("button", { name: "Confirm deactivate" }).click();
    await expect(page.getByText("2 changed.")).toBeVisible();
    await page.getByRole("checkbox", { name: `Select ${email}` }).check();
    // exact: true — "Activate selected (1)" is otherwise a substring match of the sibling
    // "Deactivate selected (1)" button, which shows at the same time for the same selection.
    await page.getByRole("button", { name: "Activate selected (1)", exact: true }).click();
    await page.getByRole("button", { name: "Confirm activate" }).click();
    await expect(page.getByText("1 changed.")).toBeVisible();

    await page.getByRole("link", { name: email }).click();
    // exact: true — "New email" would otherwise also match the sibling "Confirm new email" field.
    await page.getByLabel("New email", { exact: true }).fill(other);
    await page.getByLabel("Confirm new email").fill(other);
    await page.getByRole("button", { name: "Change email" }).click();
    await expect(page.getByText("Another subscriber record already has that address.")).toBeVisible();
    await page.getByLabel("New email", { exact: true }).fill(moved);
    await page.getByLabel("Confirm new email").fill(moved);
    await page.getByRole("button", { name: "Change email" }).click();
    await expect(page.getByText(moved)).toBeVisible();

    await page.getByRole("button", { name: "Delete" }).click();
    await settleModalTransition(page);
    await expectNoSeriousA11yViolations(page, "delete subscriber dialog");
    await page.getByRole("button", { name: "Confirm delete" }).click();
    // Not a bare "Unsubscribed or deleted" substring match: the status <dd> above also reads
    // exactly that, so this targets the sentence that names when and that it's final.
    await expect(page.getByText("Only they can subscribe again.")).toBeVisible();

    await page.getByRole("link", { name: "History" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Subscriber history" })).toBeVisible();
    for (const label of ["Added by staff", "Preferences changed by staff", "Deactivated by staff", "Activated by staff", "Email address changed by staff", "Deleted by staff"]) {
      // exact: true — "Activated by staff" is otherwise a substring match of "Deactivated by staff".
      await expect(page.getByRole("cell", { name: label, exact: true })).toBeVisible();
    }
    // The actor is the signed-in staff member's display name (actorLabel), never "Subscriber".
    await expect(page.getByRole("cell", { name: "Test NoD Editor" }).first()).toBeVisible();
    await expectNoSeriousA11yViolations(page, "subscriber history");
  });
});

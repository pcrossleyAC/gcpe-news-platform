// Acceptance item 16: "Every staff screen passes axe with no serious or critical violations."
// task-6-brief.md: axe (wcag2a/wcag2aa/wcag21aa/wcag22aa tags) on every screen and every
// dialog — sign-in, Drafts/Scheduled/Published, search, new release, the editor (incl.
// documents/side bar and the delete dialog, with a real focus-trap/inert check), every Website
// screen (incl. Blue Bridge's dialog), Users, the error log.
//
// I6: an empty screen (no releases, no slides, no links, ...) can't actually prove its rows are
// accessible — there are no rows. One `beforeAll` seeds a published release, a resource link, a
// pinned emergency pin, a file and a next-carousel slide once, up front, so every scan below
// hits populated content instead of an empty state.
import { test, expect, type Page } from "@playwright/test";
import { CAL_ADMIN_EMAIL, CAL_HQ_ADMIN_EMAIL, CAL_SYSADMIN_EMAIL, EDITOR_EMAIL, SITE_EDITOR_EMAIL, TEST_USER_PASSWORDS } from "./constants";
import {
  apiCall, baseUrl, createApprovedAndPublished, createPublishableRelease, expectNoSeriousA11yViolations, loginForCookie, ONE_PX_PNG, settleModalTransition, signInAs,
  uniqueHeadline, uploadSiteFile,
} from "./playwright-support";
import type { LinksView, PinView } from "../../apps/staff-web/src/screens/website/types";
import { FIXTURE_DAY, listFixture, listUrl, MAY, sessionOf, useCookie } from "./calendar-support";

/** Navigates, then waits for the screen's own `h1` before running axe — I6: axe sampling the
 * page mid-navigation (before the real screen, or its data, has rendered) is a false negative
 * (nothing to find violations in yet), not a clean pass. */
async function gotoAndWaitForH1(page: Page, path: string): Promise<void> {
  await page.goto(`${baseUrl()}${path}`);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
}

async function seedWebsiteContent(siteEditorCookie: string): Promise<void> {
  const links = await apiCall<LinksView>(siteEditorCookie, "/nrms/api/site/links");
  await apiCall(siteEditorCookie, "/nrms/api/site/links", {
    method: "PUT",
    body: { version: links.version, links: [...links.links, { text: "Immunization info", url: "https://www2.gov.bc.ca/immunize" }] },
  });

  const pins = await apiCall<PinView[]>(siteEditorCookie, "/nrms/api/site/pins");
  const primary = pins.find((p) => p.slot === "primary")!;
  const withHeadline = await apiCall<PinView>(siteEditorCookie, "/nrms/api/site/pins/primary", {
    method: "PUT",
    body: { version: primary.version, headline: uniqueHeadline("Axe sweep pin"), summary: "", actionUrl: "", facebookPostUrl: "", justify: "left" },
  });
  if (!withHeadline.pinned) await apiCall(siteEditorCookie, "/nrms/api/site/pins/primary/pinned", { method: "POST", body: { version: withHeadline.version, pinned: true } });

  await uploadSiteFile(siteEditorCookie, `axe-sweep-${Date.now()}.png`, ONE_PX_PNG);

  const carousels = await apiCall<{ next: { id: string; version: number } | null }>(siteEditorCookie, "/nrms/api/site/carousels");
  if (!carousels.next) {
    const now = new Date(Date.now() + 60 * 60 * 1000); // an hour out — never due during this run
    const local = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Vancouver", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
      .formatToParts(now)
      .reduce((acc, p) => ({ ...acc, [p.type]: p.value }), {} as Record<string, string>);
    await apiCall(siteEditorCookie, "/nrms/api/site/carousels/next", {
      method: "POST",
      body: { goLiveAtLocal: `${local.year}-${local.month}-${local.day}T${local.hour}:${local.minute}` },
    });
  }
  const refreshed = await apiCall<{ next: { id: string; version: number; slides: unknown[] } }>(siteEditorCookie, "/nrms/api/site/carousels");
  if (refreshed.next.slides.length === 0) {
    await apiCall(siteEditorCookie, `/nrms/api/site/carousels/${refreshed.next.id}`, {
      method: "PUT",
      body: { version: refreshed.next.version, slides: [{ headline: uniqueHeadline("Axe sweep slide"), summary: "", actionUrl: "", facebookPostUrl: "", justify: "left" }] },
    });
  }
}

/** Undoes seedWebsiteContent's two mutations to *global, singleton* Website state (the next
 * carousel; the primary pin's pinned flag) — this suite shares one stack/database with every
 * other spec file (playwright.config.ts: workers: 1), and other specs (website.spec.ts's own
 * scheduled-carousel and pin tests) assume a pristine "no next carousel" / "primary starts
 * unpinned" state the way a fresh environment has it. The seeded link and file are left in
 * place — nothing elsewhere indexes resource links or files by position, only by content it
 * created itself, so they're harmless. */
async function restoreWebsiteContent(siteEditorCookie: string): Promise<void> {
  const primary = (await apiCall<PinView[]>(siteEditorCookie, "/nrms/api/site/pins")).find((p) => p.slot === "primary")!;
  if (primary.pinned) await apiCall(siteEditorCookie, "/nrms/api/site/pins/primary/pinned", { method: "POST", body: { version: primary.version, pinned: false } });

  const carousels = await apiCall<{ next: { version: number } | null }>(siteEditorCookie, "/nrms/api/site/carousels");
  if (carousels.next) await apiCall(siteEditorCookie, `/nrms/api/site/carousels/next?version=${carousels.next.version}`, { method: "DELETE" });
}

let publishedHeadline: string;

test.describe("item 16: axe across every staff screen", () => {
  test.beforeAll(async () => {
    const editorCookie = await loginForCookie(EDITOR_EMAIL, TEST_USER_PASSWORDS[EDITOR_EMAIL]!);
    publishedHeadline = uniqueHeadline("Axe sweep published release");
    await createApprovedAndPublished(editorCookie, { headline: publishedHeadline });
    const siteEditorCookie = await loginForCookie(SITE_EDITOR_EMAIL, TEST_USER_PASSWORDS[SITE_EDITOR_EMAIL]!);
    await seedWebsiteContent(siteEditorCookie);
  });

  test.afterAll(async () => {
    const siteEditorCookie = await loginForCookie(SITE_EDITOR_EMAIL, TEST_USER_PASSWORDS[SITE_EDITOR_EMAIL]!);
    await restoreWebsiteContent(siteEditorCookie);
  });

  test("sign-in", async ({ page }) => {
    await page.goto(`${baseUrl()}/hub/sign-in`);
    await expectNoSeriousA11yViolations(page, "sign-in");
  });

  test("Drafts / Scheduled / Published (populated), Search, New release", async ({ page, context }) => {
    await signInAs(context, "editor");
    for (const path of ["/hub/releases/drafts", "/hub/releases/scheduled", "/hub/releases/published", "/hub/search", "/hub/releases/new"]) {
      await gotoAndWaitForH1(page, path);
      await expectNoSeriousA11yViolations(page, path);
    }
    // The seeded release from beforeAll gives Published at least one real row to scan, not an
    // empty-state message.
    await gotoAndWaitForH1(page, "/hub/releases/published");
    await expect(page.getByText(publishedHeadline)).toBeVisible();
  });

  test("the release editor, including Documents/side bar and a real focus-trapped, inert-background delete dialog", async ({ page, context }) => {
    const cookie = await loginForCookie(EDITOR_EMAIL, TEST_USER_PASSWORDS[EDITOR_EMAIL]!);
    const published = await createApprovedAndPublished(cookie);
    await signInAs(context, "editor");
    await page.goto(`${baseUrl()}/hub/releases/${published.id}`);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
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

  // I6: a second real-browser focus-trap/inert/restore check, on a dialog the previous round
  // of this suite never opened at all — DocumentsSection's own "Remove document" AlertDialog
  // (Remove is disabled with only one document, so this adds a second one first).
  test("the remove-document dialog traps focus, makes the background inert, and restores focus on Cancel", async ({ page, context }) => {
    const cookie = await loginForCookie(EDITOR_EMAIL, TEST_USER_PASSWORDS[EDITOR_EMAIL]!);
    const draft = await createPublishableRelease(cookie, { headline: uniqueHeadline("Axe sweep remove-document dialog") });
    await apiCall(cookie, `/nrms/api/releases/${draft.id}/documents`, { method: "POST", body: { version: draft.version, pageTitle: "Backgrounder", layout: "formal" } });

    await signInAs(context, "editor");
    await page.goto(`${baseUrl()}/hub/releases/${draft.id}`);
    const removeButton = page.getByRole("button", { name: "Remove document 1" });
    await removeButton.click();

    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText(/removes the document/)).toBeVisible();
    await settleModalTransition(page);
    await expectNoSeriousA11yViolations(page, "release editor: remove-document dialog open");

    await expect.poll(async () => page.evaluate(() => document.activeElement?.closest('[role="dialog"]') !== null)).toBe(true);
    const rootIsInert = await page.evaluate(() => (document.getElementById("root") as HTMLElement | null)?.inert ?? false);
    expect(rootIsInert).toBe(true);

    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toBeHidden();
    await expect.poll(async () => page.evaluate(() => document.activeElement?.textContent?.trim())).toBe("Remove document 1");
  });

  test("every Website screen (populated with the seeded slide/link/pin/file), including Blue Bridge's confirmation dialog", async ({ page, context }) => {
    await signInAs(context, "siteEditor");
    for (const path of ["/hub/website/carousel", "/hub/website/pins", "/hub/website/live-feed", "/hub/website/links", "/hub/website/files", "/hub/website/featured", "/hub/website/log"]) {
      await gotoAndWaitForH1(page, path);
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

  // I6: a carousel dialog, with the same real-browser focus checks as the release editor's
  // delete dialog — the seeded next carousel's slide gives "Remove slide 1" something to act on.
  test("a carousel dialog (Remove slide) traps focus, makes the background inert, and restores focus on Cancel", async ({ page, context }) => {
    await signInAs(context, "siteEditor");
    await gotoAndWaitForH1(page, "/hub/website/carousel");

    const nextSection = page.getByRole("region", { name: "Next carousel" });
    const removeButton = nextSection.getByRole("button", { name: "Remove slide 1" });
    await removeButton.click();

    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText(/removes the slide/)).toBeVisible();
    await settleModalTransition(page);
    await expectNoSeriousA11yViolations(page, "carousel: remove-slide dialog open");

    await expect.poll(async () => page.evaluate(() => document.activeElement?.closest('[role="dialog"]') !== null)).toBe(true);
    const rootIsInert = await page.evaluate(() => (document.getElementById("root") as HTMLElement | null)?.inert ?? false);
    expect(rootIsInert).toBe(true);

    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toBeHidden();
    await expect.poll(async () => page.evaluate(() => document.activeElement?.textContent?.trim())).toBe("Remove slide 1");
  });

  test("Users and the Error log", async ({ page, context }) => {
    await signInAs(context, "admin");
    await gotoAndWaitForH1(page, "/hub/users");
    await expectNoSeriousA11yViolations(page, "/hub/users");
    await gotoAndWaitForH1(page, "/hub/error-log");
    await expectNoSeriousA11yViolations(page, "/hub/error-log");
  });

  // The Calendar's staff-web screens. cal-admin covers the Administrator-visible screens;
  // cal-sysadmin additionally reaches the dead-letter page (System Administrator only).
  test("the Calendar: landing, lookups, users, Transfer, undelivered events", async ({ page, context }) => {
    const adminCookie = await loginForCookie(CAL_ADMIN_EMAIL, TEST_USER_PASSWORDS[CAL_ADMIN_EMAIL]!);
    const [adminName, adminValue] = adminCookie.split("=", 2) as [string, string];
    await context.addCookies([{ name: adminName, value: adminValue, domain: new URL(baseUrl()).hostname, path: "/", httpOnly: true, secure: false, sameSite: "Lax" }]);
    for (const path of ["/hub/calendar", "/hub/calendar/updates", "/hub/calendar/lookups", "/hub/calendar/users", "/hub/calendar/transfer"]) {
      await gotoAndWaitForH1(page, path);
      // The activity list's h1 shows while it loads: scan the filters and the loaded list, not "Loading…".
      if (path === "/hub/calendar") await expect(page.getByRole("status").filter({ hasText: /^(Showing \d+ of|No activities match)/ })).toBeVisible();
      if (path === "/hub/calendar/updates") await expect(page.getByRole("status").filter({ hasText: /^Total \d+ items?$/ })).toBeVisible();
      await expectNoSeriousA11yViolations(page, path);
    }

    const sysadminCookie = await loginForCookie(CAL_SYSADMIN_EMAIL, TEST_USER_PASSWORDS[CAL_SYSADMIN_EMAIL]!);
    const [sysName, sysValue] = sysadminCookie.split("=", 2) as [string, string];
    await context.addCookies([{ name: sysName, value: sysValue, domain: new URL(baseUrl()).hostname, path: "/", httpOnly: true, secure: false, sameSite: "Lax" }]);
    await gotoAndWaitForH1(page, "/hub/calendar/dead-letters");
    await expectNoSeriousA11yViolations(page, "/hub/calendar/dead-letters");
  });

  // The populated list as an HQ Administrator, so every HQ tool is scanned (Review selected's row
  // checkboxes, Clear LA Status, Corporate Queries, the Look Ahead filter), then its month and
  // week views of the same activities.
  test("the Calendar list as an HQ Administrator, and its month and week views", async ({ page, context }) => {
    const f = await listFixture();
    await useCookie(context, await sessionOf(CAL_HQ_ADMIN_EMAIL));
    const query = { filter: { ...MAY, quickSearch: f.tag } };
    await page.goto(listUrl(query));
    await expect(page.locator(".gcpe-activity-title")).toHaveCount(6);
    for (const name of ["Review selected (0)", "Clear LA Status"]) await expect(page.getByRole("button", { name })).toBeVisible();
    await expect(page.getByRole("checkbox", { name: `Select HLTH-${f.ids.A}` })).toBeVisible();
    await expect(page.getByRole("region", { name: "Corporate Queries" })).toBeVisible();
    await expect(page.getByRole("group", { name: "Look Ahead filter" })).toBeVisible();
    await expectNoSeriousA11yViolations(page, "the Calendar list as an HQ Administrator");

    for (const [view, heading] of [["month", "May 2031"], ["week", "Week of May 11, 2031"]] as const) {
      await page.goto(listUrl(query, `&view=${view}&on=${FIXTURE_DAY}`));
      await expect(page.getByRole("heading", { level: 2, name: heading })).toBeVisible();
      await expect(page.locator(`td[data-date="${FIXTURE_DAY}"] li`)).toHaveCount(6);
      await expectNoSeriousA11yViolations(page, `the Calendar ${view} view`);
    }
  });

  // The activity editor as an HQ Administrator (every fieldset, the Look Ahead fieldset, every
  // action), a new activity, and View changes.
  test("the Calendar activity editor, a new activity, and View changes", async ({ page, context }) => {
    const f = await listFixture();
    await useCookie(context, await sessionOf(CAL_HQ_ADMIN_EMAIL));
    await gotoAndWaitForH1(page, `/hub/calendar/activities/${f.ids.A}`);
    await expect(page.getByRole("group", { name: "Look Ahead" })).toBeVisible();
    await expectNoSeriousA11yViolations(page, "the activity editor as an HQ Administrator");
    await gotoAndWaitForH1(page, "/hub/calendar/activities/new");
    await expect(page.getByRole("textbox", { name: "Title", exact: true })).toBeVisible();
    await expectNoSeriousA11yViolations(page, "a new activity");
    await gotoAndWaitForH1(page, `/hub/calendar/activities/${f.ids.A}/changes`);
    await expect(page.getByRole("heading", { level: 1, name: `Changes to HLTH-${f.ids.A}` })).toBeVisible();
    await expectNoSeriousA11yViolations(page, "View changes");
  });
});

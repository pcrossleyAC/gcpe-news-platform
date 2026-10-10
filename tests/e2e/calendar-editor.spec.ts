// The activity editor driven as each Calendar role, an edit lock that lapses after 15 idle
// minutes, and attachments that only those who can see the activity may download (another
// ministry's confidential file is a 404). Fixtures are written by the HQ Administrator, whom the
// freeze doesn't bind; the suite's tenant moves the freeze 12 hours away, so non-exempt editors
// save at any hour, and turns the Records section on.
import { test, expect, type Page } from "@playwright/test";
import { sql } from "drizzle-orm";
import {
  CAL_ADMIN_EMAIL, CAL_ADVANCED_EMAIL, CAL_EDITOR_EMAIL, CAL_HQ_ADMIN_EMAIL, CAL_HQ_ADVANCED_EMAIL, CAL_HQ_EDITOR_EMAIL, CAL_READONLY_EMAIL, CAL_SYSADMIN_EMAIL,
} from "./constants";
import { activityInput, listFixture, listUrl, sessionOf, useCookie, type ListFixture } from "./calendar-support";
import { apiCall, baseUrl, calendarDb, expectNoSeriousA11yViolations } from "./playwright-support";

const activityUrl = (id: number) => `${baseUrl()}/hub/calendar/activities/${id}`;
const PDF = Buffer.from("%PDF-1.7\n1 0 obj << >> endobj\n%%EOF\n", "latin1");
const AUGUST = { from: "2031-08-01", to: "2031-08-31" };
const titleBox = (page: Page) => page.getByRole("textbox", { name: "Title", exact: true });
const stampOf = () => `ed${Date.now()}`;

/** A Health activity in August 2031 that a ministry editor can save as it stands (Summary, Significance and Scheduling filled). */
async function scratch(f: ListFixture, title: string, o: { confidential?: boolean } = {}): Promise<number> {
  const hq = await sessionOf(CAL_HQ_ADMIN_EMAIL);
  const body = {
    ...activityInput(f, { title, ministry: "health", contact: f.health, time: "09:00", date: "2031-08-12", confidential: o.confidential }),
    details: "Sample summary", significance: "Sample significance", schedule: "Sample scheduling",
  };
  return (await apiCall<{ id: number }>(hq, "/calendar/api/activities", { method: "POST", body })).id;
}

/** A ministry editor's change to the title: it raises `title` for HQ's review and moves the status to changed. */
async function changeTitle(id: number, title: string): Promise<void> {
  const editor = await sessionOf(CAL_EDITOR_EMAIL);
  const v = await apiCall<{ version: number; fields: object }>(editor, `/calendar/api/activities/${id}`);
  await apiCall(editor, `/calendar/api/activities/${id}`, { method: "PUT", body: { ...v.fields, title, version: v.version, tabId: null } });
}

test.describe("the activity editor, as each role (spec addendum §3 row 5e, §6)", () => {
  test("Read Only: their ministry's activity opens read-only, with the star and View changes", async ({ page, context }) => {
    const f = await listFixture();
    await useCookie(context, await sessionOf(CAL_READONLY_EMAIL));
    await page.goto(activityUrl(f.ids.C));
    await expect(page.getByRole("heading", { level: 1, name: `Activity FIN-${f.ids.C}` })).toBeVisible();
    await expect(page.getByText("You can view this activity but not change it.")).toBeVisible();
    await expect(titleBox(page)).toBeDisabled();
    await expect(page.getByRole("button", { name: "Save" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: `Watch FIN-${f.ids.C}` })).toBeVisible();
    await expectNoSeriousA11yViolations(page, "the editor, read-only");
    await page.getByRole("link", { name: "View changes" }).click();
    await expect(page.getByRole("heading", { level: 1, name: `Changes to FIN-${f.ids.C}` })).toBeVisible();
    await expect(page.getByRole("heading", { level: 2 }).first()).toContainText("Test Calendar HQ Administrator created it");
    await expectNoSeriousA11yViolations(page, "View changes");
  });

  test("Editor: opens a title from the list, saves a change, comes back to the same list, and watches the activity", async ({ page, context }) => {
    const f = await listFixture();
    const stamp = stampOf();
    const id = await scratch(f, `Edit ${stamp}`);
    await useCookie(context, await sessionOf(CAL_EDITOR_EMAIL));
    await page.goto(listUrl({ filter: { ...AUGUST, quickSearch: stamp } }));
    const link = page.getByRole("link", { name: `Edit ${stamp}` });
    await expect(link).toBeVisible();
    // The list's address as the user left it, whatever the list made of the query on load.
    const list = page.url();
    await link.click();
    await expect(page.getByRole("heading", { level: 1, name: `Activity HLTH-${id}` })).toBeVisible();
    for (const name of ["Delete", "Review"]) await expect(page.getByRole("button", { name })).toHaveCount(0);
    await expect(page.getByRole("group", { name: "Look Ahead" })).toHaveCount(0);
    await expectNoSeriousA11yViolations(page, "the editor, as a ministry editor");
    await titleBox(page).fill(`Edited ${stamp}`);
    await page.getByRole("button", { name: "Save" }).click();
    await expect(page).toHaveURL(list);
    await expect(page.getByRole("status").filter({ hasText: `Saved HLTH-${id}.` })).toBeVisible();
    await expect(page.locator(".gcpe-activity-title")).toHaveText([`Edited ${stamp}`]);

    await page.goto(activityUrl(id));
    const star = page.getByRole("button", { name: `Watch HLTH-${id}` });
    await star.click();
    await expect(star).toHaveAttribute("aria-pressed", "true");
    await page.goto(listUrl({ filter: { ...AUGUST, quickSearch: stamp }, display: "my_watchlist" }));
    await expect(page.locator(".gcpe-activity-title")).toHaveText([`Edited ${stamp}`]);
  });

  test("Editor: creates an activity from New activity, after the form's own check", async ({ page, context }) => {
    const f = await listFixture();
    const stamp = stampOf();
    await useCookie(context, await sessionOf(CAL_EDITOR_EMAIL));
    await page.goto(listUrl({ filter: { ...AUGUST, quickSearch: stamp } }));
    await page.getByRole("link", { name: "New activity" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "New activity" })).toBeVisible();
    await page.getByRole("button", { name: "Save" }).click();
    const summary = page.getByRole("alert").filter({ hasText: "Fix these to save" });
    await expect(summary.getByRole("link", { name: "Enter a title" })).toBeVisible();
    await expect(summary).toBeFocused();
    await expectNoSeriousA11yViolations(page, "a new activity's error summary");
    await page.getByRole("combobox", { name: "Category" }).selectOption(String(f.category));
    await titleBox(page).fill(`Created ${stamp}`);
    await page.getByRole("textbox", { name: "Summary" }).fill("Sample summary");
    await page.getByRole("textbox", { name: "Significance" }).fill("Sample significance");
    await page.getByRole("textbox", { name: "Scheduling considerations" }).fill("Sample scheduling");
    await page.getByRole("combobox", { name: "Comm Contact" }).selectOption(String(f.health));
    await page.getByLabel("Start date").fill("2031-08-13");
    await page.getByLabel("End date").fill("2031-08-13");
    await page.getByRole("button", { name: "Save" }).click();
    await expect(page.getByText(/^Created HLTH-\d+\.$/)).toBeVisible();
    const id = Number(/activities\/(\d+)/.exec(page.url())![1]);
    await expect(page.getByRole("heading", { level: 1, name: `Activity HLTH-${id}` })).toBeVisible();
  });

  test("Advanced: another ministry's activity shared with theirs is view-only", async ({ page, context }) => {
    const f = await listFixture();
    await useCookie(context, await sessionOf(CAL_ADVANCED_EMAIL));
    await page.goto(activityUrl(f.ids.E));
    await expect(page.getByText("Your ministry is shared on this activity: you can view it but not change it.")).toBeVisible();
    await expect(titleBox(page)).toBeDisabled();
  });

  test("Administrator: deletes an activity after confirming; it is gone for them", async ({ page, context }) => {
    const f = await listFixture();
    const id = await scratch(f, `Delete ${stampOf()}`);
    const cookie = await sessionOf(CAL_ADMIN_EMAIL);
    await useCookie(context, cookie);
    await page.goto(activityUrl(id));
    await page.getByRole("button", { name: "Delete" }).click();
    const dialog = page.getByRole("alertdialog", { name: `Delete HLTH-${id}?` });
    await expect(dialog).toBeVisible();
    await expectNoSeriousA11yViolations(page, "the delete confirmation");
    await dialog.getByRole("button", { name: "Delete" }).click();
    await expect(page).toHaveURL(`${baseUrl()}/hub/calendar`);
    await expect(page.getByRole("status").filter({ hasText: `Deleted HLTH-${id}.` })).toBeVisible();
    expect((await fetch(`${baseUrl()}/calendar/api/activities/${id}`, { headers: { cookie } })).status).toBe(404);
  });

  test("System Administrator: clones an activity and lands on the clone", async ({ page, context }) => {
    const f = await listFixture();
    const stamp = stampOf();
    const id = await scratch(f, `Clone ${stamp}`);
    await useCookie(context, await sessionOf(CAL_SYSADMIN_EMAIL));
    await page.goto(activityUrl(id));
    await page.getByRole("button", { name: "Clone" }).click();
    await expect(page.getByText(new RegExp(`^Cloned HLTH-${id} as HLTH-\\d+\\.$`))).toBeVisible();
    expect(Number(/activities\/(\d+)/.exec(page.url())![1])).not.toBe(id);
    await expect(titleBox(page)).toHaveValue(`Clone ${stamp}`);
  });

  test("HQ Editor: the Look Ahead fieldset and the needs-review markup; another ministry's confidential activity is not found", async ({ page, context }) => {
    const f = await listFixture();
    const stamp = stampOf();
    const id = await scratch(f, `Markup ${stamp}`);
    await changeTitle(id, `Markup changed ${stamp}`);
    await useCookie(context, await sessionOf(CAL_HQ_EDITOR_EMAIL));
    await page.goto(activityUrl(id));
    await expect(page.getByRole("group", { name: "Look Ahead" })).toBeVisible();
    await expect(page.getByRole("combobox", { name: "LA Section" })).toBeVisible();
    await expect(titleBox(page)).toHaveAccessibleDescription(/Changed: needs review/);
    await expect(page.getByRole("button", { name: "Review" })).toHaveCount(0);
    await expectNoSeriousA11yViolations(page, "the editor as an HQ Editor");
    await page.goto(activityUrl(f.ids.B));
    await expect(page.getByRole("heading", { level: 1, name: "Activity not found" })).toBeVisible();
  });

  test("HQ Advanced: reviews a changed activity and returns", async ({ page, context }) => {
    const f = await listFixture();
    const stamp = stampOf();
    const id = await scratch(f, `Reviewed ${stamp}`);
    await changeTitle(id, `Reviewed changed ${stamp}`);
    const hqAdvanced = await sessionOf(CAL_HQ_ADVANCED_EMAIL);
    await useCookie(context, hqAdvanced);
    await page.goto(activityUrl(id));
    await page.getByRole("button", { name: "Review" }).click();
    await expect(page.getByRole("status").filter({ hasText: `Reviewed HLTH-${id}.` })).toBeVisible();
    expect((await apiCall<{ status: string }>(hqAdvanced, `/calendar/api/activities/${id}`)).status).toBe("reviewed");
  });

  test("HQ Administrator: a deleted activity opens read-only, with Review its only action", async ({ page, context }) => {
    const f = await listFixture();
    await useCookie(context, await sessionOf(CAL_HQ_ADMIN_EMAIL));
    await page.goto(activityUrl(f.ids.F));
    await expect(page.getByText("This activity is deleted.", { exact: false })).toBeVisible();
    await expect(page.getByRole("button", { name: "Review" })).toBeEnabled();
    for (const name of ["Save", "Clone", "Delete"]) await expect(page.getByRole("button", { name })).toHaveCount(0);
    await expect(titleBox(page)).toBeDisabled();
  });
});

test("edit locks: the second user waits read-only, the lock lapses after 15 idle minutes, and the first user's stale save is refused (spec addendum §7.5)", async ({ browser }) => {
  const f = await listFixture();
  const stamp = stampOf();
  const id = await scratch(f, `Locked ${stamp}`);
  const editorContext = await browser.newContext();
  const adminContext = await browser.newContext();
  const adminCookie = await sessionOf(CAL_ADMIN_EMAIL);
  await useCookie(editorContext, await sessionOf(CAL_EDITOR_EMAIL));
  await useCookie(adminContext, adminCookie);
  const first = await editorContext.newPage();
  const second = await adminContext.newPage();
  await first.clock.install();
  await second.clock.install();
  try {
    await first.goto(activityUrl(id));
    await titleBox(first).fill(`Mine ${stamp}`);
    await expect.poll(async () => (await apiCall<{ lock: { holderName: string } | null }>(adminCookie, `/calendar/api/activities/${id}`)).lock?.holderName).toBe("Test Calendar Editor");

    await second.goto(activityUrl(id));
    await expect(second.getByText(/^Test Calendar Editor is editing this activity \(since \d{1,2}:\d{2} [AP]M\)/)).toBeVisible();
    await expect(titleBox(second)).toBeDisabled();
    await expectNoSeriousA11yViolations(second, "the editor, locked by someone else");

    // Fifteen idle minutes: the browsers' clocks for the pages' timers, the database's for the lock row.
    await first.clock.fastForward("15:01");
    await expect(first.getByText("Your edit lock lapsed.", { exact: false })).toBeVisible();
    await calendarDb().execute(sql`UPDATE activity_locks SET last_active_at = last_active_at - interval '16 minutes' WHERE activity_id = ${id}`);
    await second.clock.fastForward("00:31");
    await expect(titleBox(second)).toBeEnabled();

    await titleBox(second).fill(`Theirs ${stamp}`);
    await second.getByRole("button", { name: "Save" }).click();
    await expect(second).toHaveURL(`${baseUrl()}/hub/calendar`);

    await expect(titleBox(first)).toHaveValue(`Mine ${stamp}`);
    await first.getByRole("button", { name: "Save" }).click();
    await expect(first.getByText("Someone else changed this activity — reload to see their changes")).toBeVisible();
    await expect(titleBox(first)).toHaveValue(`Mine ${stamp}`);
    await expectNoSeriousA11yViolations(first, "the editor after a version conflict");
  } finally {
    await editorContext.close();
    await adminContext.close();
  }
});

test("attachments: another ministry's confidential file is a 404; the owning ministry downloads, adds and removes files (spec addendum §8.4; C138)", async ({ page, context }) => {
  const f = await listFixture();
  const stamp = stampOf();
  const id = await scratch(f, `Files ${stamp}`, { confidential: true });
  const hq = await sessionOf(CAL_HQ_ADMIN_EMAIL);
  const up = await fetch(`${baseUrl()}/calendar/api/activities/${id}/files`, {
    method: "POST",
    headers: { cookie: hq, "x-gcpe-request": "1", "content-type": "application/octet-stream", "x-gcpe-file-name": encodeURIComponent("Sample brief.pdf") },
    body: new Uint8Array(PDF),
  });
  expect(up.status).toBe(201);
  const [file] = (await up.json()) as { id: number }[];
  const download = async (email: string) => fetch(`${baseUrl()}/calendar/api/activities/${id}/files/${file!.id}`, { headers: { cookie: await sessionOf(email) } });
  expect((await download(CAL_READONLY_EMAIL)).status).toBe(404);
  expect((await download(CAL_HQ_EDITOR_EMAIL)).status).toBe(404);
  const own = await download(CAL_EDITOR_EMAIL);
  expect(own.status).toBe(200);
  expect(own.headers.get("content-disposition")).toContain("attachment");
  expect(own.headers.get("x-content-type-options")).toBe("nosniff");
  expect(Buffer.from(await own.arrayBuffer()).equals(PDF)).toBe(true);
  expect((await download(CAL_HQ_ADVANCED_EMAIL)).status).toBe(200);

  await useCookie(context, await sessionOf(CAL_EDITOR_EMAIL));
  await page.goto(activityUrl(id));
  const records = page.getByRole("group", { name: "Records" });
  const [saved] = await Promise.all([page.waitForEvent("download"), records.getByRole("link", { name: "Sample brief.pdf" }).click()]);
  expect(saved.suggestedFilename()).toBe("Sample brief.pdf");
  await records.getByLabel("Add files").setInputFiles([
    { name: "Sample notes.txt", mimeType: "text/plain", buffer: Buffer.from("Sample notes") },
    { name: "Sample.exe", mimeType: "application/octet-stream", buffer: Buffer.from("MZ") },
  ]);
  await expect(records.getByRole("link", { name: "Sample notes.txt" })).toBeVisible();
  await expect(records.getByRole("alert")).toHaveText("Sample.exe: This type of file can't be attached.");
  await expectNoSeriousA11yViolations(page, "Records after an upload and a refusal");
  await records.getByRole("button", { name: "Remove Sample notes.txt" }).click();
  await page.getByRole("alertdialog", { name: "Remove Sample notes.txt?" }).getByRole("button", { name: "Remove" }).click();
  await expect(records.getByRole("link", { name: "Sample notes.txt" })).toHaveCount(0);
  // Leaving the page releases the lock the uploads took.
  await page.goto(listUrl({ filter: { ...AUGUST, quickSearch: stamp } }));
});

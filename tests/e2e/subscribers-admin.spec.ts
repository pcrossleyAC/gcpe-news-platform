// NoD parity spec §8 (Lists & categories, Media lists, Operations) and §10 items 10 and 14,
// end to end through the stack, with axe on every screen and dialog. Specs run serially against
// one stack (playwright.config.ts workers: 1); every test that changes shared state restores it.
import { test, expect, type Request } from "@playwright/test";
import { apiCall, baseUrl, expectNoSeriousA11yViolations, ROLE_LOGINS, settleModalTransition, signInAs, tick } from "./playwright-support";

const unique = (label: string) => `${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.test`;

interface MediaHubEmail {
  ref: string;
  address: string;
}
interface MediaHubContact {
  id: number;
  firstName: string;
  lastName: string;
  emails: MediaHubEmail[];
  deletedAt: string | null;
}

/** Creates an NRMS media list (tolerating 409) and ticks until NoD has mirrored it. */
async function ensureMirroredMediaList(adminCookie: string, key: string, displayName: string): Promise<void> {
  const res = await fetch(`${baseUrl()}/nrms/api/media-lists`, {
    method: "POST",
    headers: { "content-type": "application/json", "X-GCPE-Request": "1", cookie: adminCookie },
    body: JSON.stringify({ key, displayName }),
  });
  if (res.status !== 201 && res.status !== 409) throw new Error(`media list creation failed: ${res.status}`);
  const start = Date.now();
  for (;;) {
    await tick();
    const lists = await apiCall<{ key: string; active: boolean }[]>(adminCookie, "/nod/api/media-lists");
    if (lists.some((l) => l.key === key && l.active)) return;
    if (Date.now() - start > 10_000) throw new Error(`media list ${key} never reached NoD`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

test.describe("Lists and categories", () => {
  test("an Admin stops offering a list and it leaves the choices; a Viewer sees counts only", async ({ page, context }) => {
    const admin = await ROLE_LOGINS.admin();
    await signInAs(context, "admin");
    await page.goto(`${baseUrl()}/hub/subscribers/lists`);
    await expect(page.getByRole("heading", { level: 1, name: "Lists and categories" })).toBeVisible();
    await expectNoSeriousA11yViolations(page, "lists and categories (admin)");
    try {
      // A plain click, not `.uncheck()`: the box is React-controlled and only flips once the
      // save round-trip and reload land, so Playwright's own single-shot post-click check
      // (expecting a synchronous DOM change) would fail even on success. `expect(...).not
      // .toBeChecked()` polls instead.
      await page.getByRole("checkbox", { name: "Offer Emergency Info BC Alerts" }).click();
      await expect(page.getByRole("status").filter({ hasText: "Emergency Info BC Alerts is no longer offered." })).toBeVisible();
      await expect(page.getByRole("checkbox", { name: "Offer Emergency Info BC Alerts" })).not.toBeChecked();
      const options = await apiCall<{ categories: { lists: { listKey: string }[] }[] }>(admin, "/nod/api/subscriber-list-options");
      expect(options.categories.flatMap((c) => c.lists.map((l) => l.listKey))).not.toContain("emergency:alerts");
    } finally {
      await apiCall(admin, "/nod/api/lists/emergency%3Aalerts", { method: "PUT", body: { enabled: true } });
    }
    const viewer = await ROLE_LOGINS.nodViewer();
    await expect(apiCall(viewer, "/nod/api/lists/emergency%3Aalerts", { method: "PUT", body: { enabled: false } })).rejects.toThrow(/403/);
  });
});

test.describe("Media lists", () => {
  test("an Editor adds by hand and from Media Hub, then removes with confirmation; a Viewer reads only", async ({ page, context }) => {
    const admin = await ROLE_LOGINS.admin();
    const editor = await ROLE_LOGINS.nodEditor();
    const key = `e2e-4g-${Date.now()}`;
    await ensureMirroredMediaList(admin, key, "E2E 4g list");
    const email = unique("media-manual");

    // A real Media Hub search term, drawn from the fake Media Hub's own contacts (not the
    // empty-string "show everything" case) -- the request-URL check below needs a term that
    // actually travels somewhere, to prove it never travels in a URL.
    const probe = await apiCall<{ contacts: MediaHubContact[] }>(editor, "/nod/api/media-hub/contacts/search", { method: "POST", body: { q: "" } });
    const target = probe.contacts.find((c) => !c.deletedAt && c.emails.length > 0);
    if (!target) throw new Error("fake Media Hub returned no usable contacts to search");
    const term = `${target.firstName} ${target.lastName}`;

    await signInAs(context, "nodEditor");
    await page.goto(`${baseUrl()}/hub/subscribers/media-lists`);
    await expectNoSeriousA11yViolations(page, "media lists");
    await page.getByRole("link", { name: "E2E 4g list" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Media list" })).toBeVisible();

    await page.getByRole("textbox", { name: "Email address" }).fill(email);
    await page.getByRole("button", { name: "Add to list" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Added to the list." })).toBeVisible();
    await expect(page.getByRole("link", { name: email })).toBeVisible();

    const seenUrls: string[] = [];
    const onRequest = (req: Request) => seenUrls.push(req.url());
    page.on("request", onRequest);
    await page.getByRole("textbox", { name: "Name, email or outlet" }).fill(term);
    await page.getByRole("button", { name: "Search Media Hub" }).click();
    const firstAdd = page.getByRole("button", { name: /^Add .+@/ }).first();
    await expect(firstAdd).toBeVisible();
    page.off("request", onRequest);
    // The search term never travels in a URL: not the page's own URL, and not any request the
    // page made while searching (the term goes in the POST body instead).
    expect(page.url()).not.toContain(term);
    expect(page.url()).not.toContain(encodeURIComponent(term));
    for (const url of seenUrls) {
      expect(url).not.toContain(term);
      expect(url).not.toContain(encodeURIComponent(term));
    }
    await firstAdd.click();
    await expect(page.getByRole("status").filter({ hasText: "Added to the list." })).toBeVisible();
    await expectNoSeriousA11yViolations(page, "media list (editor)");

    await page.getByRole("button", { name: `Remove ${email}` }).click();
    await settleModalTransition(page);
    await expectNoSeriousA11yViolations(page, "remove member dialog");
    await page.getByRole("button", { name: "Confirm remove" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Removed from the list." })).toBeVisible();
    await expect(page.getByRole("link", { name: email })).toHaveCount(0);

    await context.clearCookies();
    await signInAs(context, "nodViewer");
    await page.goto(`${baseUrl()}/hub/subscribers/media-lists/${key}`);
    await expect(page.getByRole("table", { name: "Members" })).toBeVisible();
    await expect(page.getByRole("button", { name: /^Remove / })).toHaveCount(0);
    await expect(page.getByRole("textbox", { name: "Email address" })).toHaveCount(0);
  });
});

test.describe("Operations (item 10 by hand, item 14 by role)", () => {
  test("an Admin pauses and resumes NoD with confirmation, sets the summary address, and sees the test upload", async ({ page, context }) => {
    const admin = await ROLE_LOGINS.admin();
    await signInAs(context, "admin");
    await page.goto(`${baseUrl()}/hub/subscribers/operations`);
    await expectNoSeriousA11yViolations(page, "operations");
    try {
      await page.getByRole("button", { name: "Pause News On Demand sending" }).click();
      await settleModalTransition(page);
      await expectNoSeriousA11yViolations(page, "pause dialog");
      await page.getByRole("button", { name: "Confirm pause" }).click();
      await expect(page.getByRole("status").filter({ hasText: "News On Demand sending paused." })).toBeVisible();
      await page.getByRole("button", { name: "Resume News On Demand sending" }).click();
      await page.getByRole("button", { name: "Confirm resume" }).click();
      await expect(page.getByRole("status").filter({ hasText: "News On Demand sending resumed." })).toBeVisible();
    } finally {
      await apiCall(admin, "/nod/api/settings/resume", { method: "POST" });
    }
    try {
      // The address keeps the exact casing staff typed -- assert it survives a reload, not
      // just the in-memory state right after saving.
      const typed = "Ops-Summary@Example.test";
      await page.getByRole("textbox", { name: "Bounce summary email" }).fill(typed);
      await page.getByRole("button", { name: "Save address" }).click();
      await expect(page.getByRole("status").filter({ hasText: "Bounce summary address saved." })).toBeVisible();
      await page.reload();
      await expect(page.getByRole("textbox", { name: "Bounce summary email" })).toHaveValue(typed);
      await page.getByRole("button", { name: "Use the server default" }).click();
      await expect(page.getByText(/^Using the server default: /)).toBeVisible();
      // The default is shown as text, never put in the field, so a later Save can't store it.
      await expect(page.getByRole("textbox", { name: "Bounce summary email" })).toHaveValue("");
    } finally {
      await apiCall(admin, "/nod/api/operations/bounce-summary-address", { method: "PUT", body: { address: null } });
    }
    await expect(page.getByRole("region", { name: "Test bounce upload" })).toBeVisible();
  });

  test("a NoD Editor doesn't get Operations, and the server refuses them", async ({ page, context }) => {
    await signInAs(context, "nodEditor");
    await page.goto(`${baseUrl()}/hub/subscribers`);
    await expect(page.getByRole("link", { name: "Operations" })).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Media lists" })).toBeVisible();
    const editor = await ROLE_LOGINS.nodEditor();
    await expect(apiCall(editor, "/nod/api/operations")).rejects.toThrow(/403/);
  });
});

// The 5f exit check end to end: the updates feed as several Calendar roles over the shared list
// fixture (A Health, B Health confidential, C Finance, D Finance confidential, E Finance
// confidential shared with Health, F Health deleted), each "added activity" by the HQ
// Administrator who builds it, plus F's deletion. The full role matrix runs on real Postgres in
// apps/calendar/src/http/feed-routes.test.ts.
import { test, expect, type Page } from "@playwright/test";
import { CAL_EDITOR_EMAIL, CAL_HQ_ADMIN_EMAIL, CAL_HQ_EDITOR_EMAIL, CAL_READONLY_EMAIL } from "./constants";
import { listFixture, sessionOf, useCookie, type Key, type ListFixture } from "./calendar-support";
import { baseUrl, expectNoSeriousA11yViolations } from "./playwright-support";

const updatesUrl = (q: Record<string, string> = {}) => {
  const s = new URLSearchParams(q).toString();
  return `${baseUrl()}/hub/calendar/updates${s ? `?${s}` : ""}`;
};
const entries = (page: Page) => page.locator(".gcpe-updates > li");
const ABBR: Record<Key, string> = { A: "HLTH", B: "HLTH", C: "FIN", D: "FIN", E: "FIN", F: "HLTH" };
const added = (f: ListFixture, k: Key) =>
  new RegExp(`Test Calendar HQ Administrator added activity ${ABBR[k]}-${f.ids[k]}${k === "F" ? " \\(deleted\\)" : ""}: Vis ${k} ${f.tag}`);

test.describe("the updates feed, as each role (spec addendum §3 row 5f, §9)", () => {
  const roles: [string, string, Key[]][] = [
    ["Editor (Health)", CAL_EDITOR_EMAIL, ["E", "B", "A"]],
    ["Read Only (Finance)", CAL_READONLY_EMAIL, ["E", "D", "C"]],
    ["HQ Editor", CAL_HQ_EDITOR_EMAIL, ["C", "A"]],
  ];
  for (const [who, email, keys] of roles) {
    test(`${who}: only activities they can see; confidential ones only for their own ministries; no deleted ones`, async ({ page, context }) => {
      const f = await listFixture();
      await useCookie(context, await sessionOf(email));
      await page.goto(updatesUrl({ mode: "range", keyword: f.tag }));
      await expect(entries(page)).toHaveText(keys.map((k) => added(f, k)));
      await expect(page.locator(".gcpe-updates")).not.toContainText("@");
    });
  }

  test("HQ Administrator: every activity, the deleted one marked, and its deletion", async ({ page, context }) => {
    const f = await listFixture();
    await useCookie(context, await sessionOf(CAL_HQ_ADMIN_EMAIL));
    await page.goto(updatesUrl({ mode: "range", keyword: f.tag }));
    await expect(page.getByRole("heading", { level: 2, name: `Activities updated matching "${f.tag}"` })).toBeVisible();
    await expect(entries(page)).toHaveText([
      new RegExp(`Test Calendar HQ Administrator deleted activity HLTH-${f.ids.F} \\(deleted\\): Vis F ${f.tag}`),
      ...(["F", "E", "D", "C", "B", "A"] as const).map((k) => added(f, k)),
    ]);
    await expectNoSeriousA11yViolations(page, "the updates feed, a search as an HQ Administrator");
  });

  test("Editor: an entry's link opens the activity, and Cancel comes back to the same updates (C149)", async ({ page, context }) => {
    const f = await listFixture();
    await useCookie(context, await sessionOf(CAL_EDITOR_EMAIL));
    await page.goto(updatesUrl({ mode: "range", keyword: f.tag }));
    await expect(entries(page)).toHaveCount(3);
    const here = page.url();
    await entries(page).getByRole("link", { name: `HLTH-${f.ids.A}` }).click();
    await expect(page.getByRole("heading", { level: 1, name: `Activity HLTH-${f.ids.A}` })).toBeVisible();
    await page.getByRole("button", { name: "Cancel" }).click();
    await expect(page).toHaveURL(here);
    await expect(entries(page)).toHaveCount(3);
  });

  test("HQ Editor: one activity's updates by address; another ministry's confidential activity is not found", async ({ page, context }) => {
    const f = await listFixture();
    await useCookie(context, await sessionOf(CAL_HQ_EDITOR_EMAIL));
    await page.goto(updatesUrl({ mode: "activity", activity: String(f.ids.C) }));
    await expect(page.getByRole("heading", { level: 2, name: `Updates for FIN-${f.ids.C}` })).toBeVisible();
    await expect(entries(page)).toHaveText([added(f, "C")]);
    await page.goto(updatesUrl({ mode: "activity", activity: String(f.ids.B) }));
    await expect(page.getByText("Activity not found: it doesn't exist, or you can't see it.")).toBeVisible();
    await expectNoSeriousA11yViolations(page, "the updates feed, an activity not found");
  });

  test("opens on Today's updates from the tab row; Latest 5 is one click away", async ({ page, context }) => {
    await listFixture();
    await useCookie(context, await sessionOf(CAL_HQ_ADMIN_EMAIL));
    await page.goto(`${baseUrl()}/hub/calendar`);
    await page.getByRole("navigation", { name: "Calendar sections" }).getByRole("link", { name: "Updates" }).click();
    await expect(page.getByRole("heading", { level: 2, name: "Today's updates" })).toBeVisible();
    await expect(page.getByRole("status").filter({ hasText: /^Total \d+ items?$/ })).toBeVisible();
    await expectNoSeriousA11yViolations(page, "Today's updates");
    await page.getByRole("link", { name: "Latest 5 updates" }).click();
    await expect(page.getByRole("heading", { level: 2, name: "Latest 5 updates" })).toBeVisible();
    await expect(entries(page)).toHaveCount(5);
  });
});

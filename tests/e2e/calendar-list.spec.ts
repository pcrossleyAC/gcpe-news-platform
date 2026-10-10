// The 5d exit check: every role sees exactly what the visibility rule allows (spec addendum §6),
// in the list, its id search and the Excel export; the list's journeys work end to end; axe passes
// on every state visited. Setup runs as the HQ Administrator, who is exempt from the 4pm-5pm
// freeze, so the spec runs at any hour.
import { readFileSync } from "node:fs";
import { test, expect, type Page } from "@playwright/test";
import type { ListPage } from "@gcpe/calendar-contract";
import { readXlsx } from "../../apps/calendar/test/xlsx-read";
import {
  CAL_ADMIN_EMAIL, CAL_ADVANCED_EMAIL, CAL_EDITOR_EMAIL, CAL_HQ_ADMIN_EMAIL, CAL_HQ_ADVANCED_EMAIL, CAL_HQ_EDITOR_EMAIL, CAL_READONLY_EMAIL, CAL_SYSADMIN_EMAIL,
} from "./constants";
import { activityInput, listFixture, listUrl, MAY, sessionOf, useCookie, type Key } from "./calendar-support";
import { apiCall, baseUrl, expectNoSeriousA11yViolations } from "./playwright-support";

const titles = (page: Page) => page.locator(".gcpe-activity-title");
const q = (query: object) => encodeURIComponent(JSON.stringify(query));

/** The activity ids the list shows, in order, read from each row's "MIN-Id". */
async function screenIds(page: Page): Promise<number[]> {
  return (await page.locator(".gcpe-activity-cell strong").allTextContents()).map((t) => Number(/-(\d+)$/.exec(t)![1]));
}

/** The export's activity ids, in order: column A below the two header rows, without the footer. */
function exportIds(cells: Map<string, string>): number[] {
  return [...cells].filter(([ref, v]) => /^A\d+$/.test(ref) && Number(ref.slice(1)) > 2 && /^\d+$/.test(v)).map(([, v]) => Number(v));
}

const ROLES: [string, string, Key[]][] = [
  ["Read Only (Finance)", CAL_READONLY_EMAIL, ["C", "D", "E"]],
  ["Editor (Health)", CAL_EDITOR_EMAIL, ["A", "B", "E"]],
  ["Advanced (Health)", CAL_ADVANCED_EMAIL, ["A", "B", "E"]],
  ["Administrator (Health)", CAL_ADMIN_EMAIL, ["A", "B", "E"]],
  ["System Administrator (Health)", CAL_SYSADMIN_EMAIL, ["A", "B", "E"]],
  ["HQ Editor", CAL_HQ_EDITOR_EMAIL, ["A", "C"]],
  ["HQ Advanced", CAL_HQ_ADVANCED_EMAIL, ["A", "B", "C", "D", "E"]],
  ["HQ Administrator", CAL_HQ_ADMIN_EMAIL, ["A", "B", "C", "D", "E", "F"]],
];

test.describe("the Calendar list: visibility for each role (spec addendum §6)", () => {
  for (const [role, email, keys] of ROLES) {
    test(`${role} sees exactly what the visibility rule allows, as the server lists and exports it`, async ({ page, context }) => {
      const f = await listFixture();
      const cookie = await sessionOf(email);
      const query = { filter: { ...MAY, quickSearch: f.tag } };
      const expected = keys.map((k) => f.ids[k]);

      const server = await apiCall<ListPage>(cookie, `/calendar/api/list?q=${q(query)}&offset=0`);
      expect(server.rows.map((r) => r.id)).toEqual(expected);
      const res = await fetch(`${baseUrl()}/calendar/api/list/export.xlsx?q=${q(query)}`, { headers: { cookie } });
      expect(res.status).toBe(200);
      expect(exportIds(readXlsx(Buffer.from(await res.arrayBuffer())).cells)).toEqual(expected);

      await useCookie(context, cookie);
      await page.goto(listUrl(query));
      await expect(titles(page)).toHaveText(keys.map((k) => `Vis ${k} ${f.tag}`));
      expect(await screenIds(page)).toEqual(server.rows.map((r) => r.id));
      await expectNoSeriousA11yViolations(page, `the list as ${role}`);
    });
  }

  test("an id search and the Excel export stay inside visibility (C127, C151)", async ({ page, context }) => {
    const f = await listFixture();
    const hqEditor = await sessionOf(CAL_HQ_EDITOR_EMAIL);
    await useCookie(context, hqEditor);
    await page.goto(listUrl({ filter: { quickSearch: `FIN-${f.ids.D}` } }));
    await expect(page.getByText("No activities match.")).toBeVisible();
    const res = await fetch(`${baseUrl()}/calendar/api/list/export.xlsx?q=${q({ filter: { ...MAY, quickSearch: f.tag } })}`, { headers: { cookie: hqEditor } });
    expect(res.status).toBe(200);
    const { cells } = readXlsx(Buffer.from(await res.arrayBuffer()));
    expect([...cells].filter(([ref]) => /^E\d+$/.test(ref) && Number(ref.slice(1)) > 2).map(([, v]) => v)).toEqual([`Vis A ${f.tag}`, `Vis C ${f.tag}`]);
    await useCookie(context, await sessionOf(CAL_READONLY_EMAIL));
    await page.goto(listUrl({ filter: { quickSearch: `FIN-${f.ids.D}` } }));
    await expect(titles(page)).toHaveText([`Vis D ${f.tag}`]);
  });
});

test.describe("the Calendar list: journeys", () => {
  test("a ministry editor saves, runs, renames and deletes a query, watches an activity, hides a column and exports", async ({ page, context }) => {
    const f = await listFixture();
    await useCookie(context, await sessionOf(CAL_EDITOR_EMAIL));
    await page.goto(listUrl({ filter: { ...MAY, quickSearch: f.tag } }));
    await expect(titles(page)).toHaveCount(3);
    const queries = page.getByRole("region", { name: "My Queries" });
    await queries.getByLabel("Name for this filter").fill(`Sample query ${f.tag}`);
    await queries.getByRole("button", { name: "Save query" }).click();
    await expect(queries.getByRole("status")).toHaveText(`Saved the query “Sample query ${f.tag}”.`);
    await page.goto(`${baseUrl()}/hub/calendar`);
    await queries.getByRole("button", { name: `Sample query ${f.tag}`, exact: true }).click();
    await expect(titles(page)).toHaveText([`Vis A ${f.tag}`, `Vis B ${f.tag}`, `Vis E ${f.tag}`]);
    await queries.getByRole("button", { name: `Rename Sample query ${f.tag}` }).click();
    await expectNoSeriousA11yViolations(page, "My Queries, renaming");
    await queries.getByLabel("New name").fill(`Renamed ${f.tag}`);
    await queries.getByRole("button", { name: "Save name" }).click();
    await expect(queries.getByRole("status")).toHaveText(`Renamed to “Renamed ${f.tag}”.`);
    await queries.getByRole("button", { name: `Delete Renamed ${f.tag}` }).click();
    await expect(queries.getByRole("status")).toHaveText(`Deleted the query “Renamed ${f.tag}”.`);

    const star = page.getByRole("button", { name: `Watch HLTH-${f.ids.A}` });
    await star.click();
    await expect(star).toHaveAttribute("aria-pressed", "true");
    await page.goto(listUrl({ filter: { ...MAY, quickSearch: f.tag }, display: "my_watchlist" }));
    await expect(titles(page)).toHaveText([`Vis A ${f.tag}`]);
    await page.getByRole("button", { name: `Watch HLTH-${f.ids.A}` }).click();
    await expect(page.getByRole("button", { name: `Watch HLTH-${f.ids.A}` })).toHaveAttribute("aria-pressed", "false");

    await page.goto(listUrl({ filter: { ...MAY, quickSearch: f.tag } }));
    await expect(titles(page)).toHaveCount(3);
    const savedPreferences = () => page.waitForResponse((r) => r.url().endsWith("/calendar/api/list/preferences") && r.request().method() === "PUT" && r.ok());
    await page.getByText("Columns", { exact: true }).click();
    await Promise.all([savedPreferences(), page.getByRole("checkbox", { name: "City", exact: true }).uncheck()]);
    await expect(page.getByRole("columnheader", { name: "City", exact: true })).toHaveCount(0);
    await page.reload();
    await expect(titles(page)).toHaveCount(3);
    await expect(page.getByRole("columnheader", { name: "City", exact: true })).toHaveCount(0);
    await page.getByText("Columns", { exact: true }).click();
    await Promise.all([savedPreferences(), page.getByRole("checkbox", { name: "City", exact: true }).check()]);
    await expect(page.getByRole("columnheader", { name: "City", exact: true })).toHaveCount(1);

    const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Excel export" }).click()]);
    expect(download.suggestedFilename()).toBe("BCGovernmentActivities.xlsx");
    const { cells } = readXlsx(readFileSync(await download.path()));
    expect(exportIds(cells)).toEqual([f.ids.A, f.ids.B, f.ids.E]);
  });

  test("an HQ Administrator reviews selected rows, skipping one changed meanwhile, clears LA status, runs a corporate query and filters by Look Ahead", async ({ page, context }) => {
    const f = await listFixture();
    const hq = await sessionOf(CAL_HQ_ADMIN_EMAIL);
    const rev = `rev${Date.now()}`;
    const make = async (key: string, time: string) =>
      (await apiCall<{ id: number }>(hq, "/calendar/api/activities", { method: "POST", body: activityInput(f, { title: `Rev ${key} ${rev}`, ministry: "health", contact: f.health, time, date: "2031-06-10" }) })).id;
    const g = await make("G", "09:00");
    const h = await make("H", "10:00");
    await useCookie(context, hq);
    await page.goto(listUrl({ filter: { from: "2031-06-01", to: "2031-06-30", quickSearch: rev } }));
    await expect(titles(page)).toHaveCount(2);
    await page.getByRole("checkbox", { name: `Select HLTH-${g}` }).check();
    await page.getByRole("checkbox", { name: `Select HLTH-${h}` }).check();
    // H changes after the list loaded.
    const view = await apiCall<{ version: number; fields: object }>(hq, `/calendar/api/activities/${h}`);
    await apiCall(hq, `/calendar/api/activities/${h}`, { method: "PUT", body: { ...view.fields, title: `Rev H changed ${rev}`, version: view.version, tabId: null } });
    await page.getByRole("button", { name: "Review selected (2)" }).click();
    await expect(page.getByText(`Reviewed 1 activity. 1 skipped because it changed since the list loaded: HLTH-${h}.`)).toBeVisible();
    await expectNoSeriousA11yViolations(page, "after Review selected");
    expect((await apiCall<ListPage>(hq, `/calendar/api/list?q=${q({ filter: { from: "2031-06-01", to: "2031-06-30", quickSearch: rev } })}&offset=0`)).rows.map((r) => [r.id, r.status])).toEqual([
      [g, "reviewed"],
      [h, "changed"],
    ]);

    await page.getByLabel("Days ahead").fill("0");
    await page.getByRole("button", { name: "Clear LA Status" }).click();
    await expect(page.getByText(/^Cleared the LA status of \d+ activit(y|ies)\.$/)).toBeVisible();

    const corp = page.getByRole("region", { name: "Corporate Queries" });
    await corp.getByLabel("Show all").check();
    await corp.getByRole("button", { name: "Search" }).click();
    await expect(corp.getByText("Showing a corporate query.")).toBeVisible();
    await expect(page.getByText(/^Showing \d+ of \d+ activit(y|ies)\.$/)).toBeVisible();
    await expectNoSeriousA11yViolations(page, "a corporate query");
    await corp.getByRole("button", { name: "Back to the filter" }).click();
    await expect(corp.getByText("Showing a corporate query.")).toHaveCount(0);

    await page.goto(listUrl({ filter: { ...MAY, quickSearch: f.tag } }));
    await expect(titles(page)).toHaveCount(6);
    // The radio is checked once the URL carries the new query, a beat after the click.
    const notForLookAhead = page.getByRole("group", { name: "Look Ahead filter" }).getByLabel("Not for Look Ahead Only");
    await notForLookAhead.click();
    await expect(notForLookAhead).toBeChecked();
    await expect(titles(page)).toHaveText([`Vis B ${f.tag}`, `Vis D ${f.tag}`, `Vis E ${f.tag}`]);
  });

  test("the month and week views show the filter's activities", async ({ page, context }) => {
    const f = await listFixture();
    await useCookie(context, await sessionOf(CAL_EDITOR_EMAIL));
    await page.goto(listUrl({ filter: { quickSearch: f.tag } }, "&view=month&on=2031-05-01"));
    await expect(page.getByRole("heading", { level: 2, name: "May 2031" })).toBeVisible();
    const day = page.locator('td[data-date="2031-05-14"] li');
    await expect(day).toHaveText([`HLTH-${f.ids.A} 9:00 AM Vis A ${f.tag}`, `HLTH-${f.ids.B} 10:00 AM Vis B ${f.tag}`, `FIN-${f.ids.E} 1:00 PM Vis E ${f.tag}`]);
    await expectNoSeriousA11yViolations(page, "the month view");
    await page.goto(listUrl({ filter: { quickSearch: f.tag } }, "&view=week&on=2031-05-14"));
    await expect(page.getByRole("heading", { level: 2, name: "Week of May 11, 2031" })).toBeVisible();
    await expect(day).toHaveCount(3);
    await expectNoSeriousA11yViolations(page, "the week view");
  });
});

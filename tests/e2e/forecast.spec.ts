// Parent spec §10.2's Calendar → NRMS leg, spec addendum §3 row 5h's exit check: a Calendar
// activity appears on NRMS's Forecast, a release is started from it (pre-filled), approved,
// scheduled and published, and the activity shows each status. Fixed dates in 2031, so nothing
// depends on the hour the suite runs: "publish" moves the scheduled time into the past rather
// than waiting for it. Seeded sessions only (global-setup).
import { test, expect } from "@playwright/test";
import { sql } from "drizzle-orm";
import type { ForecastPage, ReleaseView } from "@gcpe/nrms-contract";
import { CAL_HQ_ADMIN_EMAIL, CAL_SYSADMIN_EMAIL, EDITOR_EMAIL, PLANNER_EMAIL } from "./constants";
import { activityInput, listFixture, sessionOf, useCookie } from "./calendar-support";
import { apiCall, baseUrl, expectNoSeriousA11yViolations, nrmsDb, tick } from "./playwright-support";

/** The Forecast page holding `activityId`'s row (as the planner sees it), polling while the activity travels to NRMS. */
async function forecastPageOf(cookie: string, find: (p: ForecastPage) => boolean): Promise<number> {
  let found = 0;
  await expect
    .poll(
      async () => {
        await tick();
        for (let page = 1; page <= 40; page++) {
          const p = await apiCall<ForecastPage>(cookie, `/nrms/api/forecast?page=${page}`);
          if (find(p)) return (found = page);
          if (page * p.pageSize >= p.total) break;
        }
        return 0;
      },
      { timeout: 15_000 },
    )
    .toBeGreaterThan(0);
  return found;
}

/** The statuses of the releases the Calendar shows on the activity, after letting events flow. */
const calendarStatuses = (cookie: string, activityId: number) => async () => {
  await tick();
  return (await apiCall<{ releases: { status: string }[] }>(cookie, `/calendar/api/activities/${activityId}`)).releases.map((r) => r.status);
};

test.describe("parent spec §10.2: Calendar activity → Forecast → draft → approve → schedule → publish → status on the activity", () => {
  test("the planner starts a pre-filled release from the Forecast, and the activity follows it to published", async ({ page, context }) => {
    test.setTimeout(120_000);
    const f = await listFixture(); // the Health comm contact and a city
    const sys = await sessionOf(CAL_SYSADMIN_EMAIL);
    const hq = await sessionOf(CAL_HQ_ADMIN_EMAIL);
    const planner = await sessionOf(PLANNER_EMAIL);
    const stamp = Date.now();
    // Forecast takes categories starting "Approved" (BC tenant). Not 12 or 58, the release categories.
    let category = await apiCall<{ id: number }>(sys, "/calendar/api/lookups/categories", { method: "POST", body: { name: `Approved E2E forecast ${stamp}` } });
    while ([2, 12, 58].includes(category.id)) category = await apiCall<{ id: number }>(sys, "/calendar/api/lookups/categories", { method: "POST", body: { name: `Approved E2E forecast ${stamp}-${category.id}` } });
    const title = `Forecast clinic ${stamp}`;
    const activity = await apiCall<{ id: number }>(hq, "/calendar/api/activities", {
      method: "POST",
      body: { ...activityInput({ category: category.id, city: f.city }, { title, ministry: "health", contact: f.health, time: "10:00", date: "2031-06-11" }), translations: ["French"] },
    });

    // The Forecast, as the planner sees it.
    const pageNo = await forecastPageOf(planner, (p) => p.items.some((i) => i.kind === "activity" && i.activity.activityId === activity.id));
    await useCookie(context, planner);
    await page.goto(`${baseUrl()}/hub/releases/forecast?page=${pageNo}`);
    const row = page.locator("li.gcpe-release-row", { has: page.getByRole("link", { name: new RegExp(title) }) });
    await expect(row).toContainText(`Planned for Jun 11, 2031 10:00 AM · Calendar activity ID ${activity.id}`);
    await expectNoSeriousA11yViolations(page, "the Forecast");

    // Draft: started from the activity, pre-filled.
    await row.getByRole("link", { name: "Start a release" }).click();
    await expect(page.getByLabel("Calendar activity ID")).toHaveValue(String(activity.id));
    await expect(page.getByRole("group", { name: "Ministries" }).getByLabel("Health")).toBeChecked();
    await expect(page.getByText("Translations required: French")).toBeVisible();
    await expect(page.getByText("Planned publish date: Jun 11, 2031 10:00 AM, from the activity.", { exact: false })).toBeVisible();
    await expectNoSeriousA11yViolations(page, "a new release filled in from an activity");
    await page.getByLabel("Page title").selectOption("News Release");
    await page.getByLabel("Headline", { exact: false }).fill(`Clinic opens ${stamp}`);
    await page.getByRole("button", { name: "Create release" }).click();
    await expect(page).toHaveURL(/\/hub\/releases\/[0-9a-f-]{36}$/);
    const releaseId = page.url().split("/").at(-1)!;
    await expect.poll(calendarStatuses(hq, activity.id), { timeout: 15_000 }).toEqual(["draft"]);
    // Linked to a release planned from now on, the activity leaves the Forecast; the release takes its place.
    const forecast = await apiCall<ForecastPage>(planner, `/nrms/api/forecast?page=${pageNo}`);
    expect(forecast.items.some((i) => i.kind === "activity" && i.activity.activityId === activity.id)).toBe(false);
    await forecastPageOf(planner, (p) => p.items.some((i) => i.kind === "release" && i.release.id === releaseId));

    // The body and sector a release needs before it can go out, then approve and schedule.
    let view = await apiCall<ReleaseView>(planner, `/nrms/api/releases/${releaseId}`);
    const doc = view.documents[0]!;
    view = await apiCall<ReleaseView>(planner, `/nrms/api/releases/${releaseId}/documents/${doc.id}/4105`, {
      method: "PUT",
      body: {
        version: view.version, pageTitle: "News Release", layout: "formal", headline: `Clinic opens ${stamp}`, subheadline: null, organizations: "Ministry of Health",
        byline: null, bodyHtml: "<p>A fictional clinic opens.</p>", pageImageId: null, contacts: ["Media Relations\n250-555-0100"],
      },
    });
    view = await apiCall<ReleaseView>(planner, `/nrms/api/releases/${releaseId}/categories`, {
      method: "PUT", body: { version: view.version, leadMinistryKey: "health", ministries: view.ministries, sectors: ["health"], themes: view.themes, tags: view.tags },
    });
    view = await apiCall<ReleaseView>(planner, `/nrms/api/releases/${releaseId}/approve`, { method: "POST", body: { version: view.version } });
    await expect.poll(calendarStatuses(hq, activity.id), { timeout: 15_000 }).toEqual(["approved"]);
    view = await apiCall<ReleaseView>(planner, `/nrms/api/releases/${releaseId}/schedule`, { method: "POST", body: { version: view.version, publishAtLocal: "2031-06-11T10:00" } });
    expect(view.status).toBe("scheduled");
    await expect.poll(calendarStatuses(hq, activity.id), { timeout: 15_000 }).toEqual(["scheduled"]);

    // Publish: the scheduled time moved into the past, so the next publisher run takes it.
    await nrmsDb().execute(sql`UPDATE news_releases SET publish_at = now() - interval '1 minute' WHERE id = ${releaseId}`);
    await expect.poll(calendarStatuses(hq, activity.id), { timeout: 20_000 }).toEqual(["published"]);

    // The activity page shows it, with a link for an NRMS user.
    await page.goto(`${baseUrl()}/hub/calendar/activities/${activity.id}`);
    const news = page.getByRole("region", { name: "BC Gov News" });
    await expect(news).toContainText(`Release ${view.reference}: Published`);
    await expect(news.getByRole("link")).toHaveAttribute("href", `/hub/releases/${releaseId}`);
    await expectNoSeriousA11yViolations(page, "the activity with its published release");
  });

  test("an NRMS Editor without Calendar access sees releases only, and is told why", async ({ page, context }) => {
    const editor = await sessionOf(EDITOR_EMAIL);
    const forecast = await apiCall<ForecastPage>(editor, "/nrms/api/forecast?page=1");
    expect(forecast.calendarActivities).toBe(false);
    expect(forecast.items.every((i) => i.kind === "release")).toBe(true);
    await useCookie(context, editor);
    await page.goto(`${baseUrl()}/hub/releases/forecast`);
    await expect(page.getByText("Calendar activities are listed here for people with Calendar access.", { exact: false })).toBeVisible();
    await expectNoSeriousA11yViolations(page, "the Forecast without Calendar access");
  });
});

// Owner decision 2026-10-31: every BC time the Hub shows is right whatever browser shows it. CI's
// Playwright Chromium has tzdata from before BC's permanent UTC-7 (2026-11-01), so on CI this
// runs as exactly the browser the correction is for; on an up-to-date one it checks nothing changed.
import { test, expect } from "@playwright/test";
import { CAL_EDITOR_EMAIL, CAL_HQ_ADMIN_EMAIL } from "./constants";
import { activityInput, listFixture, listUrl, sessionOf, useCookie } from "./calendar-support";
import { apiCall } from "./playwright-support";

test("a winter 09:00 activity after BC's change shows at 9:00 AM, and an out-of-date browser is told", async ({ page, context }) => {
  const f = await listFixture();
  const tag = `bctime${Date.now()}`;
  await apiCall(await sessionOf(CAL_HQ_ADMIN_EMAIL), "/calendar/api/activities", {
    method: "POST",
    body: activityInput(f, { title: `BC time ${tag}`, ministry: "health", contact: f.health, time: "09:00", date: "2031-12-10" }),
  });
  await useCookie(context, await sessionOf(CAL_EDITOR_EMAIL));
  await page.goto(listUrl({ filter: { quickSearch: tag } }, "&view=month&on=2031-12-01"));
  const oldRules = await page.evaluate(
    () => new Intl.DateTimeFormat("en-US", { timeZone: "America/Vancouver", timeZoneName: "longOffset" }).format(new Date("2031-12-10T17:00:00Z")).endsWith("GMT-08:00"),
  );
  await expect(page.locator('td[data-date="2031-12-10"] li')).toHaveText(new RegExp(`^HLTH-\\d+ 9:00 AM BC time ${tag}$`));
  const notice = page.getByText("The times shown here have been corrected for BC time", { exact: false });
  if (oldRules) await expect(notice).toBeVisible();
  else await expect(notice).toHaveCount(0);
});

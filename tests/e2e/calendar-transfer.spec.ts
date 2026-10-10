// A Calendar Administrator sees a user's open activities before deactivating them, moves those
// activities to another comm contact with Transfer, and the list is then empty. Setup runs as
// the HQ Administrator, who is exempt from the 4pm-5pm freeze, so the test runs at any hour.
import { test, expect } from "@playwright/test";
import { ADMIN_PASSWORD, ADMIN_USERNAME, CAL_ADMIN_EMAIL, CAL_HQ_ADMIN_EMAIL, CAL_SYSADMIN_EMAIL, TEST_USER_PASSWORDS } from "./constants";
import { apiCall, baseUrl, expectNoSeriousA11yViolations, loginForCookie, tick } from "./playwright-support";

test.describe("Calendar Transfer and the deactivation preview", () => {
  test("open activities are listed, transferred, and gone from the list", async ({ page, context }) => {
    const stamp = Date.now();
    const core = await loginForCookie(ADMIN_USERNAME, ADMIN_PASSWORD);
    const sys = await loginForCookie(CAL_SYSADMIN_EMAIL, TEST_USER_PASSWORDS[CAL_SYSADMIN_EMAIL]!);
    const admin = await loginForCookie(CAL_ADMIN_EMAIL, TEST_USER_PASSWORDS[CAL_ADMIN_EMAIL]!);
    const hq = await loginForCookie(CAL_HQ_ADMIN_EMAIL, TEST_USER_PASSWORDS[CAL_HQ_ADMIN_EMAIL]!);

    const people: { id: string }[] = [];
    for (const who of ["A", "B"]) {
      const u = await apiCall<{ id: string }>(core, "/core/api/users", { method: "POST", body: { email: `cal-contact-${who.toLowerCase()}-${stamp}@example.test`, displayName: `Contact ${who} ${stamp}` } });
      await apiCall(core, `/core/api/calendar-access/${u.id}`, { method: "PUT", body: { role: "Calendar.Editor", organizationKeys: ["health"] } });
      people.push(u);
    }
    await tick();
    for (const p of people) await apiCall(admin, `/calendar/api/users/${p.id}/comm-contacts/health`, { method: "PUT", body: { rank: 4 } });

    // A category outside the configured release categories (12, 58), and a city.
    let category = await apiCall<{ id: number }>(sys, "/calendar/api/lookups/categories", { method: "POST", body: { name: `E2E category ${stamp}` } });
    while ([12, 58].includes(category.id)) category = await apiCall<{ id: number }>(sys, "/calendar/api/lookups/categories", { method: "POST", body: { name: `E2E category ${stamp}-${category.id}` } });
    const city = await apiCall<{ id: number }>(sys, "/calendar/api/lookups/cities", { method: "POST", body: { name: `E2E city ${stamp}` } });
    const contacts = await apiCall<{ id: number; label: string }[]>(hq, "/calendar/api/transfer/comm-contacts");
    const a = contacts.find((c) => c.label === `Contact A ${stamp} (HLTH)`)!;
    const input = {
      categoryId: category.id, title: `E2E activity ${stamp}`, details: "", significance: "", strategy: "", schedule: "", comments: "", leadOrganization: "", venue: "", otherCity: "", potentialDates: "",
      isIssue: false, isConfidential: false, isMilestone: false, isCrossGovernment: false, isAtLegislature: false, isAllDay: false, isConfirmed: true,
      startDate: "2030-03-10", startTime: "09:00", endDate: "2030-03-10", endTime: "10:00", nrDate: null, nrTime: null,
      contactMinistryKey: "health", commContactId: a.id, governmentRepresentativeId: null, cityId: city.id, premierRequestedId: null,
      nrDistributionId: null, eventPlannerId: null, videographerId: null, nrOriginId: null,
      commMaterialIds: [], initiativeIds: [], keywordNames: [], sectorKeys: [], themeKeys: [], tagKeys: [], sharedWithKeys: [], translations: [],
    };
    for (let n = 0; n < 2; n++) await apiCall(hq, "/calendar/api/activities", { method: "POST", body: { ...input, title: `${input.title} ${n}` } });

    const [name, value] = admin.split("=", 2) as [string, string];
    await context.addCookies([{ name, value, domain: new URL(baseUrl()).hostname, path: "/", httpOnly: true, secure: false, sameSite: "Lax" }]);

    await page.goto(`${baseUrl()}/hub/calendar/users/${people[0]!.id}`);
    await page.getByRole("button", { name: `Deactivate Contact A ${stamp}` }).click();
    const preview = page.getByRole("region", { name: `Before deactivating Contact A ${stamp}` });
    await expect(preview.getByRole("listitem")).toHaveCount(2);
    await expectNoSeriousA11yViolations(page, "deactivation preview");
    await preview.getByRole("button", { name: "Cancel" }).click();

    await page.goto(`${baseUrl()}/hub/calendar/transfer`);
    await expect(page.getByRole("heading", { level: 1, name: "Transfer activities" })).toBeVisible();
    await page.getByLabel("From comm contact").selectOption({ label: `Contact A ${stamp} (HLTH)` });
    await page.getByLabel("To comm contact").selectOption({ label: `Contact B ${stamp} (HLTH)` });
    await page.getByRole("button", { name: "Preview" }).click();
    await expect(page.getByText(`2 activities will move from Contact A ${stamp} (HLTH) to Contact B ${stamp} (HLTH).`, { exact: false })).toBeVisible();
    await expectNoSeriousA11yViolations(page, "Transfer");
    await page.getByRole("button", { name: "Transfer 2 activities" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Transferred" })).toHaveText(`Transferred 2 activities from Contact A ${stamp} (HLTH) to Contact B ${stamp} (HLTH).`);

    await page.goto(`${baseUrl()}/hub/calendar/users/${people[0]!.id}`);
    await page.getByRole("button", { name: `Deactivate Contact A ${stamp}` }).click();
    await expect(page.getByRole("region", { name: `Before deactivating Contact A ${stamp}` }).getByText("No open activities.")).toBeVisible();
  });
});

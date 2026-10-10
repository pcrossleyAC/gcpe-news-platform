// Acceptance item 1, Core half: a Calendar Administrator sets a user's role and ministries on
// the Calendar access screen, isn't offered System Administrator or an HQ ministry, and the
// server refuses both even when asked directly. Visibility of activities is 5c's half.
import { test, expect } from "@playwright/test";
import { healthOrg } from "../../apps/core/test/helpers";
import { ADMIN_PASSWORD, ADMIN_USERNAME, CAL_ADMIN_EMAIL, TEST_USER_PASSWORDS } from "./constants";
import { apiCall, baseUrl, expectNoSeriousA11yViolations, loginForCookie } from "./playwright-support";

test.describe("Calendar access", () => {
  test("a Calendar Administrator grants Editor with a ministry, and can't grant System Administrator or an HQ ministry", async ({ page, context }) => {
    const admin = await loginForCookie(ADMIN_USERNAME, ADMIN_PASSWORD);
    const stamp = Date.now();
    await apiCall(admin, "/core/api/organizations/health", { method: "PUT", body: healthOrg });
    await apiCall(admin, "/core/api/organizations/gcpe-headquarters", {
      method: "PUT",
      body: { ...healthOrg, key: "gcpe-headquarters", displayName: "GCPE Headquarters", abbreviation: "GCPEHQ", sectorKeys: [], isHq: true },
    });
    const staff = await apiCall<{ id: string }>(admin, "/core/api/users", { method: "POST", body: { email: `cal-staff-${stamp}@example.test`, displayName: `Calendar Staff ${stamp}` } });

    // The seeded Calendar Administrator (Health), not one of this test's own: every distinct
    // user costs a real login against the stack's 10/min limiter (see loginForCookie).
    const cookie = await loginForCookie(CAL_ADMIN_EMAIL, TEST_USER_PASSWORDS[CAL_ADMIN_EMAIL]!);
    const [name, value] = cookie.split("=", 2) as [string, string];
    await context.addCookies([{ name, value, domain: new URL(baseUrl()).hostname, path: "/", httpOnly: true, secure: false, sameSite: "Lax" }]);

    await page.goto(`${baseUrl()}/hub/`);
    await expect(page).toHaveURL(/\/hub\/calendar-access$/);
    await expect(page.getByRole("heading", { level: 1, name: "Calendar access" })).toBeVisible();
    await expectNoSeriousA11yViolations(page, "Calendar access");

    await page.getByRole("button", { name: `Edit access for Calendar Staff ${stamp}` }).click();
    const form = page.getByRole("form", { name: `Calendar access for Calendar Staff ${stamp}` });
    const roleSelect = form.getByLabel("Calendar role");
    await expect(roleSelect.locator("option")).toHaveText(["No Calendar access", "Read Only", "Editor", "Advanced", "Administrator"]);
    await roleSelect.selectOption("Calendar.Editor");
    await form.getByLabel(/^Health/).check();
    // A non-HQ Administrator isn't offered an HQ ministry: the server would refuse it.
    await expect(form.getByLabel(/^GCPE Headquarters/)).toHaveCount(0);
    await expectNoSeriousA11yViolations(page, "Calendar access editor");
    await form.getByRole("button", { name: "Save Calendar access" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Saved Calendar access" })).toHaveText(`Saved Calendar access for Calendar Staff ${stamp}.`);
    // Scoped to this run's row: a retried run leaves an earlier Calendar Staff with the same text.
    const row = page.getByRole("row").filter({ hasText: `Calendar Staff ${stamp}` });
    await expect(row.getByRole("cell")).toHaveText([`cal-staff-${stamp}@example.test`, "Editor", "HLTH", "Edit access for Calendar Staff " + stamp]);

    // The server refuses what the screen doesn't offer.
    const direct = (body: object) =>
      fetch(`${baseUrl()}/core/api/calendar-access/${staff.id}`, {
        method: "PUT",
        headers: { cookie, "content-type": "application/json", "x-gcpe-request": "1" },
        body: JSON.stringify(body),
      });
    const sys = await direct({ role: "Calendar.SysAdmin", organizationKeys: ["health"] });
    expect(sys.status).toBe(403);
    expect(await sys.json()).toMatchObject({ reason: "above-ceiling" });
    const hq = await direct({ role: "Calendar.Editor", organizationKeys: ["gcpe-headquarters"] });
    expect(hq.status).toBe(403);
    expect(await hq.json()).toMatchObject({ reason: "hq-organization" });
  });
});

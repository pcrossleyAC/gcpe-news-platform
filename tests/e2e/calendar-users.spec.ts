// The Calendar users screen end to end: a seeded Calendar Administrator edits a Calendar-only
// user's contact details and rank, deactivates them, and is refused on a user with an NRMS role.
import { test, expect } from "@playwright/test";
import { ADMIN_PASSWORD, ADMIN_USERNAME, CAL_ADMIN_EMAIL, TEST_USER_PASSWORDS } from "./constants";
import { apiCall, baseUrl, expectNoSeriousA11yViolations, loginForCookie, tick } from "./playwright-support";

test.describe("Calendar users", () => {
  test("a Calendar Administrator edits a user's contact details, rank and account", async ({ page, context }) => {
    const admin = await loginForCookie(ADMIN_USERNAME, ADMIN_PASSWORD);
    const stamp = Date.now();
    const staff = await apiCall<{ id: string }>(admin, "/core/api/users", { method: "POST", body: { email: `cal-user-${stamp}@example.test`, displayName: `Calendar User ${stamp}` } });
    await apiCall(admin, `/core/api/calendar-access/${staff.id}`, { method: "PUT", body: { role: "Calendar.Editor", organizationKeys: ["health"] } });
    await tick();

    const cookie = await loginForCookie(CAL_ADMIN_EMAIL, TEST_USER_PASSWORDS[CAL_ADMIN_EMAIL]!);
    const [name, value] = cookie.split("=", 2) as [string, string];
    await context.addCookies([{ name, value, domain: new URL(baseUrl()).hostname, path: "/", httpOnly: true, secure: false, sameSite: "Lax" }]);

    await page.goto(`${baseUrl()}/hub/calendar/users`);
    await expect(page.getByRole("heading", { level: 1, name: "Calendar users" })).toBeVisible();
    await expectNoSeriousA11yViolations(page, "Calendar users");
    await page.getByRole("link", { name: new RegExp(`^Calendar User ${stamp} \\(HLTH\\)`) }).click();
    await expect(page.getByRole("heading", { level: 1, name: `Calendar User ${stamp}` })).toBeVisible();

    const profile = page.getByRole("form", { name: "Contact details" });
    // Mobile carries legacy's 12-digit-and-hyphens CHECK constraint (Phone has only a length
    // limit — see apps/calendar/src/users.ts).
    await profile.getByLabel("Mobile").fill("250 555 0100");
    await profile.getByRole("button", { name: "Save contact details" }).click();
    await expect(profile.getByRole("alert")).toHaveText("use 12 digits and hyphens, like 250-555-0100");
    await profile.getByLabel("Mobile").fill("250-555-0100");
    await profile.getByRole("button", { name: "Save contact details" }).click();
    // The shared Announcer region is also role="status" — scope to the one with this text.
    await expect(page.getByRole("status").filter({ hasText: "Saved contact details." })).toHaveText("Saved contact details.");

    await page.getByLabel("Comm contact rank for Health (HLTH)").selectOption("4");
    await expect(page.getByRole("status").filter({ hasText: "Saved the comm-contact rank." })).toHaveText("Saved the comm-contact rank.");
    await expectNoSeriousA11yViolations(page, "Calendar user");

    await page.getByRole("button", { name: `Deactivate Calendar User ${stamp}` }).click();
    await expect(page.getByRole("status").filter({ hasText: "is deactivated." })).toContainText(`Calendar User ${stamp} is deactivated.`);

    // Q55: a user who also holds an NRMS role is a Core admin's to change, not a Calendar
    // Administrator's — even once they also hold a Calendar role.
    const dual = await apiCall<{ id: string }>(admin, "/core/api/users", { method: "POST", body: { email: `cal-dual-${stamp}@example.test`, displayName: `Calendar Dual ${stamp}`, roles: ["NRMS.Viewer"] } });
    await apiCall(admin, `/core/api/calendar-access/${dual.id}`, { method: "PUT", body: { role: "Calendar.Editor", organizationKeys: ["health"] } });
    const refused = await fetch(`${baseUrl()}/core/api/calendar-access/${dual.id}/active`, {
      method: "PUT",
      headers: { cookie, "content-type": "application/json", "x-gcpe-request": "1" },
      body: JSON.stringify({ isActive: false }),
    });
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({ reason: "other-roles" });
  });
});

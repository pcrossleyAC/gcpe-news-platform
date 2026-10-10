// The 5b exit check's lookup half: a Calendar Administrator manages an unlocked lookup and can
// only read a locked one; a System Administrator changes the locked one; the server refuses what
// the screen doesn't offer; a revoked grant is refused on the next request.
import { test, expect } from "@playwright/test";
import { healthOrg } from "../../apps/core/test/helpers";
import { ADMIN_PASSWORD, ADMIN_USERNAME } from "./constants";
import { apiCall, baseUrl, expectNoSeriousA11yViolations, loginForCookie, tick } from "./playwright-support";

test.describe("Calendar lookups", () => {
  test("an Administrator edits HQ tags and reads Categories; a System Administrator edits Categories", async ({ page, context }) => {
    const admin = await loginForCookie(ADMIN_USERNAME, ADMIN_PASSWORD);
    const stamp = Date.now();
    await apiCall(admin, "/core/api/organizations/health", { method: "PUT", body: healthOrg });
    const mk = async (who: string, role: string) => {
      const email = `cal-${who}-${stamp}@example.test`;
      const u = await apiCall<{ id: string }>(admin, "/core/api/users", { method: "POST", body: { email, displayName: `Calendar ${who} ${stamp}`, password: `e2e-cal-${who}-password-1` } });
      await apiCall(admin, `/core/api/calendar-access/${u.id}`, { method: "PUT", body: { role, organizationKeys: ["health"] } });
      return { id: u.id, email, password: `e2e-cal-${who}-password-1` };
    };
    const calAdmin = await mk("admin", "Calendar.Administrator");
    const sysAdmin = await mk("sysadmin", "Calendar.SysAdmin");
    await tick(); // Core's user.upserted and org.upserted reach the Calendar's projections

    const cookie = await loginForCookie(calAdmin.email, calAdmin.password);
    const [name, value] = cookie.split("=", 2) as [string, string];
    await context.addCookies([{ name, value, domain: new URL(baseUrl()).hostname, path: "/", httpOnly: true, secure: false, sameSite: "Lax" }]);

    await page.goto(`${baseUrl()}/hub/calendar/lookups`);
    await expect(page.getByRole("heading", { level: 1, name: "Calendar lookups" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Categories (read only)" })).toBeVisible();
    await expectNoSeriousA11yViolations(page, "Calendar lookups");

    await page.getByRole("link", { name: "HQ tags" }).click();
    const add = page.getByRole("form", { name: "Add an HQ tag" });
    await add.getByLabel("Name").fill(`Sample keyword ${stamp}`);
    await add.getByRole("button", { name: "Add" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Added Sample keyword" })).toHaveText(`Added Sample keyword ${stamp}.`);
    await page.getByRole("button", { name: `Edit Sample keyword ${stamp}` }).click();
    const edit = page.getByRole("form", { name: `Edit Sample keyword ${stamp}` });
    await edit.getByLabel("Active").uncheck();
    await edit.getByRole("button", { name: "Save" }).click();
    await expect(page.getByRole("row", { name: new RegExp(`Sample keyword ${stamp}`) })).toContainText("Inactive");
    await expectNoSeriousA11yViolations(page, "HQ tags");

    await page.goto(`${baseUrl()}/hub/calendar/lookups/categories`);
    await expect(page.getByText("Only a System Administrator can change categories.")).toBeVisible();
    const refused = await fetch(`${baseUrl()}/calendar/api/lookups/categories`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json", "x-gcpe-request": "1" },
      body: JSON.stringify({ name: `Sample category ${stamp}` }),
    });
    expect(refused.status).toBe(403);

    const sysCookie = await loginForCookie(sysAdmin.email, sysAdmin.password);
    const created = await fetch(`${baseUrl()}/calendar/api/lookups/categories`, {
      method: "POST",
      headers: { cookie: sysCookie, "content-type": "application/json", "x-gcpe-request": "1" },
      body: JSON.stringify({ name: `Sample category ${stamp}` }),
    });
    expect(created.status).toBe(201);

    // A revoked grant is refused on the very next request with the same cookie.
    await apiCall(admin, `/core/api/calendar-access/${calAdmin.id}`, { method: "PUT", body: { role: null, organizationKeys: [] } });
    await tick();
    expect((await fetch(`${baseUrl()}/calendar/api/me`, { headers: { cookie } })).status).toBe(403);
  });
});

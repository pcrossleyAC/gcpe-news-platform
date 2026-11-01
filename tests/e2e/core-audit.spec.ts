// Suite review O3: Core admin changes record who made them (History on Users and Organizations,
// and the Admin history screen), and Users shows when each person last signed in.
import { test, expect } from "@playwright/test";
import { apiCall, baseUrl, expectNoSeriousA11yViolations, ROLE_LOGINS, signInAs } from "./playwright-support";

test.describe("Core admin audit trail", () => {
  test("a change made as the break-glass admin shows in the person's History and in Admin history; Last signed in follows a real sign-in", async ({ page, context }) => {
    const admin = await ROLE_LOGINS.admin();
    const stamp = Date.now();
    const email = `audit-${stamp}@example.test`;
    const name = `Audit Person ${stamp}`;
    const password = `audit password ${stamp}`;
    const created = await apiCall<{ id: string }>(admin, "/core/api/users", { method: "POST", body: { email, displayName: name, roles: ["NRMS.Viewer"], password } });
    await apiCall(admin, `/core/api/users/${created.id}/roles`, { method: "PUT", body: { roles: ["NRMS.Editor", "NRMS.Viewer"] } });

    await signInAs(context, "admin");
    await page.goto(`${baseUrl()}/hub/users`);
    const table = page.getByRole("table", { name: "Staff users" });
    const row = table.getByRole("row").filter({ has: page.getByRole("rowheader", { name, exact: true }) });
    // Email, Sign-in, Roles, Status, Last signed in (the name is the row's header, not a cell).
    const lastSignedIn = row.getByRole("cell").nth(4);
    await expect(lastSignedIn).toHaveText("Never");

    // A real password sign-in by that person.
    const login = await fetch(`${baseUrl()}/core/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-gcpe-request": "1" },
      body: JSON.stringify({ username: email, password }),
    });
    expect(login.status).toBe(200);
    await page.reload();
    await expect(lastSignedIn).toHaveText(/\d{1,2}:\d{2}\s[AP]M$/);

    await row.getByRole("button", { name: `Edit ${email}` }).click();
    await page.getByRole("button", { name: "History" }).click();
    const history = page.getByRole("list", { name: `Changes to ${name}, newest first` });
    await expect(history.getByRole("listitem")).toHaveText([
      new RegExp(`Administrator \\(break-glass\\) gave NRMS Editor to ${name}$`),
      new RegExp(`Administrator \\(break-glass\\) added ${name} \\(${email}\\) with NRMS Viewer$`),
    ]);
    await expectNoSeriousA11yViolations(page, "/hub/users with History open");

    await page.goto(`${baseUrl()}/hub/admin-history`);
    await expect(page.getByRole("heading", { level: 1, name: "Admin history" })).toBeVisible();
    await page.getByLabel("Who").fill("break-glass");
    await page.getByLabel("What").selectOption({ label: "Users" });
    await page.getByRole("button", { name: "Show" }).click();
    await expect(page).toHaveURL(/\/hub\/admin-history\?who=break-glass&kind=users$/);
    const entries = page.getByRole("table", { name: "Admin history, newest first" });
    await expect(entries.getByRole("row").nth(1)).toContainText(`Gave NRMS Editor to ${name}`);
    await expectNoSeriousA11yViolations(page, "/hub/admin-history");

    // Phone width: the page itself never scrolls sideways (the table scrolls in its own box).
    await page.setViewportSize({ width: 390, height: 800 });
    await expect(entries).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  });

  test("Admin history is for Core administrators only", async ({ page, context }) => {
    await signInAs(context, "editor");
    await page.goto(`${baseUrl()}/hub/admin-history`);
    await expect(page.getByText("You don’t have permission to view this page.")).toBeVisible();
    const editor = await ROLE_LOGINS.editor();
    const res = await fetch(`${baseUrl()}/core/api/audit`, { headers: { cookie: editor } });
    expect(res.status).toBe(403);
  });
});

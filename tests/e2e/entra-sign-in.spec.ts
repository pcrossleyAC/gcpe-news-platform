// Entra staff sign-in (docs/superpowers/specs/2026-10-12-entra-staff-sign-in-design.md),
// through the stack's fake Microsoft sign-in (FAKE_ENTRA_ENABLED in global-setup.ts).
import { test, expect } from "@playwright/test";
import { FAKE_ENTRA_IDENTITIES } from "../../apps/stack/src/env";
import { apiCall, baseUrl, ROLE_LOGINS, signInAs } from "./playwright-support";

const [STAFF, UNKNOWN] = FAKE_ENTRA_IDENTITIES;

test.describe("Sign in with Microsoft", () => {
  test("a provisioned user lands in the staff app with their Core roles, and an admin can unlink them", async ({ page, browser }) => {
    await apiCall(await ROLE_LOGINS.admin(), "/core/api/users", { method: "POST", body: { email: STAFF.email, displayName: STAFF.name, roles: ["NRMS.Editor"] } });

    await page.goto(`${baseUrl()}/hub/sign-in`);
    await page.getByRole("link", { name: "Sign in with Microsoft" }).click();
    await expect(page.getByRole("heading", { name: "Fake Microsoft sign-in" })).toBeVisible();
    await page.getByRole("link", { name: `${STAFF.name} (${STAFF.email})` }).click();

    await expect(page).toHaveURL(/\/hub\/releases\/drafts$/);
    await expect(page.getByText(`Signed in as ${STAFF.name}`)).toBeVisible();
    await expect(page.getByRole("link", { name: "New release" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Users" })).toHaveCount(0);

    const adminContext = await browser.newContext();
    await signInAs(adminContext, "admin");
    const admin = await adminContext.newPage();
    await admin.goto(`${baseUrl()}/hub/users`);
    const row = admin.getByRole("listitem").filter({ has: admin.getByRole("heading", { name: STAFF.email, level: 3 }) });
    await expect(row.getByText("Sign-in: Microsoft (Entra)")).toBeVisible();
    await row.getByRole("button", { name: `Unlink ${STAFF.email} from Microsoft sign-in` }).click();
    await expect(row.getByText("Sign-in: Local password")).toBeVisible();
    await adminContext.close();
  });

  test("someone without a Core account is told to contact an administrator", async ({ page }) => {
    await page.goto(`${baseUrl()}/hub/sign-in`);
    await page.getByRole("link", { name: "Sign in with Microsoft" }).click();
    await page.getByRole("link", { name: `${UNKNOWN.name} (${UNKNOWN.email})` }).click();
    await expect(page).toHaveURL(/\/hub\/sign-in\?error=not_provisioned$/);
    await expect(page.getByRole("alert")).toHaveText("Your account hasn't been set up. Contact an administrator.");
  });
});

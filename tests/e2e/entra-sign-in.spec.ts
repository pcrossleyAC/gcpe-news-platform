// Entra staff sign-in (docs/superpowers/specs/2026-10-12-entra-staff-sign-in-design.md),
// through the stack's fake Microsoft sign-in (FAKE_ENTRA_ENABLED in global-setup.ts).
import { test, expect } from "@playwright/test";
import { FAKE_ENTRA_IDENTITIES } from "../../apps/stack/src/env";
import { apiCall, baseUrl, ROLE_LOGINS, signInAs } from "./playwright-support";

const [STAFF, UNKNOWN] = FAKE_ENTRA_IDENTITIES;

test.describe("Sign in with Microsoft", () => {
  test("a provisioned user lands in the staff app with their Core roles, NoD and the Calendar accept the session, an admin can unlink them, and sign-out clears it", async ({ page, browser }) => {
    await apiCall(await ROLE_LOGINS.admin(), "/core/api/users", { method: "POST", body: { email: STAFF.email, displayName: STAFF.name, roles: ["NRMS.Editor"] } });

    await page.goto(`${baseUrl()}/hub/sign-in`);
    await page.getByRole("link", { name: "Sign in with Microsoft" }).click();
    await expect(page.getByRole("heading", { name: "Fake Microsoft sign-in" })).toBeVisible();
    await page.getByRole("link", { name: `${STAFF.name} (${STAFF.email})` }).click();

    await expect(page).toHaveURL(/\/hub\/releases\/drafts$/);
    await expect(page.getByText(`Signed in as ${STAFF.name}`)).toBeVisible();
    await expect(page.getByRole("link", { name: "New release" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Users" })).toHaveCount(0);

    // The Entra session is the same gcpe_session cookie as a password session's — NoD and
    // the Calendar must accept it too (actor resolved, then the role check runs), not just NRMS.
    // STAFF has neither app's role, so each refuses 403 "forbidden", never 401 "no session".
    const sessionCookie = (await page.context().cookies()).find((c) => c.name === "gcpe_session");
    expect(sessionCookie).toBeTruthy();
    const cookieHeader = `${sessionCookie!.name}=${sessionCookie!.value}`;
    expect((await fetch(`${baseUrl()}/nod/api/reports/unsubscribes`, { headers: { cookie: cookieHeader } })).status).toBe(403);
    expect((await fetch(`${baseUrl()}/calendar/api/lookups/categories`, { headers: { cookie: cookieHeader } })).status).toBe(403);

    const adminContext = await browser.newContext();
    await signInAs(adminContext, "admin");
    const admin = await adminContext.newPage();
    await admin.goto(`${baseUrl()}/hub/users`);
    const row = admin.getByRole("listitem").filter({ has: admin.getByRole("heading", { name: STAFF.email, level: 3 }) });
    await expect(row.getByText("Sign-in: Microsoft (Entra)")).toBeVisible();
    await row.getByRole("button", { name: `Unlink ${STAFF.email} from Microsoft sign-in` }).click();
    await admin.getByRole("alertdialog").getByRole("button", { name: "Unlink" }).click();
    await expect(row.getByText("Sign-in: Local password")).toBeVisible();
    await adminContext.close();

    // Sign-out clears the Entra session's cookie exactly as it clears a password session's.
    await page.getByRole("button", { name: "Sign out" }).click();
    await expect(page).toHaveURL(/\/hub\/sign-in(\?|$)/);
    expect((await page.context().cookies()).some((c) => c.name === "gcpe_session")).toBe(false);
  });

  test("someone without a Core account is told to contact an administrator", async ({ page }) => {
    await page.goto(`${baseUrl()}/hub/sign-in`);
    await page.getByRole("link", { name: "Sign in with Microsoft" }).click();
    await page.getByRole("link", { name: `${UNKNOWN.name} (${UNKNOWN.email})` }).click();
    await expect(page).toHaveURL(/\/hub\/sign-in\?error=not_provisioned$/);
    await expect(page.getByRole("alert")).toHaveText("Your account hasn't been set up. Contact an administrator.");
  });
});

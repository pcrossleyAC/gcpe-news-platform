// Acceptance item 5: "Publish now -> News API post -> static page -> NoD email in Mailpit,
// within one publisher run." Approve/Publish now are driven through the UI; the chain to the
// News API, the static page and the SMTP sink is proven with exactly one /stack/tick call.
import { test, expect } from "@playwright/test";
import { ADMIN_USERNAME, ADMIN_PASSWORD, EDITOR_EMAIL, TEST_USER_PASSWORDS } from "./constants";
import { apiCall, baseUrl, createPublishableRelease, ensureSubscriber, loginForCookie, signInAs, tick, uniqueHeadline, waitForMessageWithSubject } from "./playwright-support";
import type { ReleaseView } from "@gcpe/nrms-contract";

test.describe("item 5: publish now reaches the News API, the static site and a NoD email", () => {
  test("approve + publish now through the UI; one tick delivers everything", async ({ page, context }) => {
    const editorCookie = await loginForCookie(EDITOR_EMAIL, TEST_USER_PASSWORDS[EDITOR_EMAIL]!);
    const adminCookie = await loginForCookie(ADMIN_USERNAME, ADMIN_PASSWORD);

    const headline = uniqueHeadline("Weekend clinics open across B.C.");
    const subscriberEmail = `subscriber-${Date.now()}@example.test`;
    await ensureSubscriber(adminCookie, subscriberEmail, ["ministries:health"]);

    const created = await createPublishableRelease(editorCookie, { headline });

    await signInAs(context, "editor");
    await page.goto(`${baseUrl()}/hub/releases/${created.id}`);

    await page.getByRole("button", { name: "Approve" }).click();
    await expect(page.getByRole("button", { name: "Publish now" })).toBeVisible();
    await page.getByRole("button", { name: "Publish now" }).click();
    // Scoped to the header's own status line — the page-level status announcement (aria-live,
    // for screen readers) also contains this word ("Status: Publishing...").
    await expect(page.locator(".gcpe-release-editor__meta").getByText(/Scheduled|Publishing/)).toBeVisible();

    await tick();

    const view = await apiCall<ReleaseView>(editorCookie, `/nrms/api/releases/${created.id}`);
    expect(view.status).toBe("published");
    expect(view.key).not.toBeNull();

    const siteRes = await fetch(`${baseUrl()}/site/releases/${view.key}/`);
    expect(siteRes.status).toBe(200);
    expect(await siteRes.text()).toContain(headline);

    const mail = await waitForMessageWithSubject(`BC Gov News - ${headline}`);
    expect(mail.to).toContain(subscriberEmail);
  });
});

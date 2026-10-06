// Acceptance item 10: "Delete: permanent without a reference; hidden with one."
import { test, expect } from "@playwright/test";
import { EDITOR_EMAIL, TEST_USER_PASSWORDS } from "./constants";
import { eq } from "drizzle-orm";
import { apiCall, approveRelease, baseUrl, createPublishableRelease, loginForCookie, nrmsDb, signInAs } from "./playwright-support";
import { newsReleases } from "../../apps/nrms/src/db/schema";

async function deleteThroughUi(page: import("@playwright/test").Page, id: string): Promise<void> {
  await page.goto(`${baseUrl()}/hub/releases/${id}`);
  await page.getByRole("button", { name: "Delete" }).click();
  await page.getByRole("button", { name: "Confirm delete" }).click();
  await expect(page).toHaveURL(/\/hub\/releases\/drafts$/);
}

test.describe("item 10: delete", () => {
  test("a never-approved draft (no reference) is permanently deleted", async ({ page, context }) => {
    const cookie = await loginForCookie(EDITOR_EMAIL, TEST_USER_PASSWORDS[EDITOR_EMAIL]!);
    const draft = await createPublishableRelease(cookie);
    expect(draft.reference).toBeNull();

    await signInAs(context, "editor");
    await deleteThroughUi(page, draft.id);

    await expect(apiCall(cookie, `/nrms/api/releases/${draft.id}`)).rejects.toThrow(/404/);
  });

  test("an approved release (has a reference) is hidden, not erased", async ({ page, context }) => {
    const cookie = await loginForCookie(EDITOR_EMAIL, TEST_USER_PASSWORDS[EDITOR_EMAIL]!);
    const draft = await createPublishableRelease(cookie);
    const approved = await approveRelease(cookie, draft);
    expect(approved.reference).not.toBeNull();

    await signInAs(context, "editor");
    await deleteThroughUi(page, approved.id);

    // The regular GET (and every list) treats a "deleted" release the same as truly gone
    // (apps/nrms/src/releases/queries.ts's `releaseVisible`/`ne(status, "deleted")`) — so
    // "hidden, not erased" has to be checked against the row itself, directly.
    await expect(apiCall(cookie, `/nrms/api/releases/${approved.id}`)).rejects.toThrow(/404/);
    const [row] = await nrmsDb().select({ status: newsReleases.status, reference: newsReleases.reference }).from(newsReleases).where(eq(newsReleases.id, approved.id));
    expect(row).toBeDefined();
    expect(row!.status).toBe("deleted");
    expect(row!.reference).not.toBeNull();

    const drafts = await apiCall<{ items: { id: string }[] }>(cookie, "/nrms/api/releases?folder=drafts&type=all&page=1&pageSize=100");
    expect(drafts.items.some((i) => i.id === approved.id)).toBe(false);
  });
});

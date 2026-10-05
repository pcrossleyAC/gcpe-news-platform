// Acceptance item 7: "Editing a published release re-publishes it as a correction, with a log
// entry and a new frozen copy."
import { test, expect } from "@playwright/test";
import { EDITOR_EMAIL, TEST_USER_PASSWORDS } from "./constants";
import { apiCall, baseUrl, createApprovedAndPublished, loginForCookie, signInAs, tickTwice, uniqueHeadline } from "./playwright-support";
import type { ReleaseView } from "@gcpe/nrms-contract";

interface Publication {
  id: number;
  publishedAt: string;
  actorName: string;
}

test.describe("item 7: editing a published release republishes it as a correction", () => {
  test("a headline edit after publish shows Republishing, writes a log entry, and produces a second frozen copy", async ({ page, context }) => {
    const cookie = await loginForCookie(EDITOR_EMAIL, TEST_USER_PASSWORDS[EDITOR_EMAIL]!);
    const headline = uniqueHeadline("Correction-republish release");
    const published = await createApprovedAndPublished(cookie, { headline });

    const before = await apiCall<Publication[]>(cookie, `/nrms/api/releases/${published.id}/publications`);
    expect(before.length).toBe(1);

    await signInAs(context, "editor");
    await page.goto(`${baseUrl()}/hub/releases/${published.id}`);

    const docsSection = page.getByRole("region", { name: "Documents" });
    const firstDoc = docsSection.locator(".gcpe-documents__item").first();
    const correctedHeadline = `${headline} (corrected)`;
    await firstDoc.getByLabel("Headline", { exact: true }).fill(correctedHeadline);
    await firstDoc.getByRole("button", { name: /Save English content/ }).click();

    await expect(page.getByText("Republishing...")).toBeVisible();

    await tickTwice();
    await page.reload();
    await expect(page.getByText("Published", { exact: true })).toBeVisible();

    const after = await apiCall<ReleaseView>(cookie, `/nrms/api/releases/${published.id}`);
    expect(after.status).toBe("published");

    const afterPublications = await apiCall<Publication[]>(cookie, `/nrms/api/releases/${published.id}/publications`);
    expect(afterPublications.length).toBe(2);
    // dbClock's publish timestamps can land in the same millisecond as the first publish when
    // the suite runs this fast — >= (not strictly >) is still a real assertion that a second,
    // distinct frozen copy exists (the length check above), just not a stronger ordering claim
    // than the clock can actually promise.
    expect(Date.parse(afterPublications[1]!.publishedAt)).toBeGreaterThanOrEqual(Date.parse(before[0]!.publishedAt));

    // The routine "Edited after publishing" log entry is hidden by default; "Show all" reveals it.
    await page.getByRole("checkbox", { name: "Show all" }).check({ force: true });
    await expect(page.getByText(/Edited after publishing/)).toBeVisible();
  });
});

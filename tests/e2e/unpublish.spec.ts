// Acceptance item 8: "Unpublish removes the release from the News API and the site; an
// Advisory has no Unpublish."
import { test, expect } from "@playwright/test";
import { EDITOR_EMAIL, TEST_USER_PASSWORDS } from "./constants";
import { apiCall, baseUrl, createApprovedAndPublished, createPublishableRelease, approveRelease, publishNow, loginForCookie, signInAs, tickTwice, uniqueHeadline } from "./playwright-support";
import type { ReleaseView } from "@gcpe/nrms-contract";

test.describe("item 8: unpublish", () => {
  test("unpublishing a release takes it off the News API and the public site", async ({ page, context }) => {
    const cookie = await loginForCookie(EDITOR_EMAIL, TEST_USER_PASSWORDS[EDITOR_EMAIL]!);
    const published = await createApprovedAndPublished(cookie);
    const key = published.key!;

    const beforeRes = await fetch(`${baseUrl()}/site/releases/${key}/`);
    expect(beforeRes.status).toBe(200);

    await signInAs(context, "editor");
    await page.goto(`${baseUrl()}/hub/releases/${published.id}`);
    await page.getByRole("button", { name: "Unpublish" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    // I6: wait for the unpublish POST's own response (not just the click) before ticking —
    // ticking before the server has actually recorded the unpublish is a race.
    await Promise.all([
      page.waitForResponse((r) => r.request().method() === "POST" && r.url().includes("/unpublish")),
      dialog.getByRole("button", { name: "Confirm unpublish" }).click(),
    ]);
    await expect(dialog).toBeHidden();
    await tickTwice();

    const after = await apiCall<ReleaseView>(cookie, `/nrms/api/releases/${published.id}`);
    expect(after.status).toBe("approved");

    const afterRes = await fetch(`${baseUrl()}/site/releases/${key}/`);
    expect(afterRes.status).toBe(404);

    // I6: the brief asks this spec to also assert the News API itself no longer returns the
    // post — apps/news-api/src/http/v1/posts.ts answers a missing/unpublished key with 200 and
    // an empty body (emptyOk), not a 404, so the empty text is what actually proves it's gone.
    const newsApiRes = await fetch(`${baseUrl()}/api/Posts/${key}?api-version=1.0`);
    expect(newsApiRes.status).toBe(200);
    expect(await newsApiRes.text()).toBe("");
  });

  test("an Advisory never shows an Unpublish button, even once published", async ({ page, context }) => {
    const cookie = await loginForCookie(EDITOR_EMAIL, TEST_USER_PASSWORDS[EDITOR_EMAIL]!);
    const created = await createPublishableRelease(cookie, {
      type: "advisory", sectors: [], themes: [], tags: [], mediaListKeys: ["regional"], headline: uniqueHeadline("Media advisory"),
    });
    const approved = await approveRelease(cookie, created);
    const published = await publishNow(cookie, approved);
    await tickTwice();
    expect((await apiCall<ReleaseView>(cookie, `/nrms/api/releases/${published.id}`)).status).toBe("published");

    await signInAs(context, "editor");
    await page.goto(`${baseUrl()}/hub/releases/${published.id}`);
    await expect(page.getByText(/^Sent/)).toBeVisible();
    await expect(page.getByRole("button", { name: "Unpublish" })).toHaveCount(0);
  });
});

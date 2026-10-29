// Addendum §7 and §9: the staff panel works in AI mode with the stand-in provider (the suite's
// tenant has staffAi on), and the panel has no axe violations at all (6e exit).
import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { EDITOR_EMAIL, TEST_USER_PASSWORDS } from "./constants";
import { baseUrl, createApprovedAndPublished, createPublishableRelease, loginForCookie, signInAs, tick } from "./playwright-support";

test("Find similar lists a matching published release as an AI match, and the panel has zero axe violations", async ({ page, context }) => {
  const cookie = await loginForCookie(EDITOR_EMAIL, TEST_USER_PASSWORDS[EDITOR_EMAIL]!);
  const word = `quokkaferry${Date.now().toString(36)}`;
  const headline = `Similar check ${word} ferry terminal upgrade`;
  const published = await createApprovedAndPublished(cookie, { headline });
  await tick(); // the News API's embedding worker runs on the stack tick
  const draft = await createPublishableRelease(cookie, { headline });

  await signInAs(context, "editor");
  await page.goto(`${baseUrl()}/hub/releases/${draft.id}`);
  const panel = page.getByRole("region", { name: "Similar published releases" });
  // The panel's contents sit behind a disclosure that starts closed.
  await panel.getByRole("button", { name: "Open similar-release search" }).click();
  await expect(panel.getByText("Sends this draft's text to the AI service to compare.")).toBeVisible();
  await panel.getByRole("button", { name: "Find similar" }).click();

  const item = panel.getByRole("listitem").filter({ hasText: word });
  await expect(item).toContainText("AI match");
  await expect(item.getByRole("link")).toHaveAttribute("href", new RegExp(`/releases/${published.key}$`));

  const results = await new AxeBuilder({ page }).include("#similar-releases").withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
  expect(results.violations).toEqual([]);
});

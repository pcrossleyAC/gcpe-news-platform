// Suite review O1.3 (owner 2026-10-31), fix round 1 (controller rulings 2026-11-01): the Hub's
// Undelivered updates screen, end to end. Deliveries NoD "refused" are written straight into NRMS's
// outbox (the dispatcher takes 24 hours to give up on one for real). A Core administrator sees them
// at desktop and phone widths; a release published then unpublished shows the published one as
// replaced and never resends it; Retry all asks first; Dismiss records who did it.
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { expect, test, type Page } from "@playwright/test";
import { baseUrl, expectNoSeriousA11yViolations, nrmsDb, settleModalTransition, signInAs } from "./playwright-support";

const TAG = randomUUID().slice(0, 8);
const HEADLINE = `Undelivered e2e probe ${TAG}`;
const WITHDRAWN = `Withdrawn e2e probe ${TAG}`;
const OTHER = `Other e2e probe ${TAG}`;
const CORRECTED = `Corrected e2e probe ${TAG}`;

async function deadInNrms(type: string, aggregateId: string, sequence: number, headline: string, hoursAgo: number): Promise<string> {
  const id = randomUUID();
  const envelope = { id, type, data: { key: `2026E2E-${id.slice(0, 6)}`, documents: [{ headline }], e2e: TAG } };
  await nrmsDb().execute(
    sql`INSERT INTO outbox_events (id, type, aggregate_id, sequence, envelope, created_at) VALUES (${id}, ${type}, ${aggregateId}, ${sequence}, ${JSON.stringify(envelope)}::jsonb, now() - (${hoursAgo} * interval '1 hour'))`,
  );
  await nrmsDb().execute(sql`INSERT INTO outbox_deliveries (event_id, subscriber, status, attempts, last_error) VALUES (${id}, 'nod', 'dead', 9, 'HTTP 503')`);
  return id;
}

const statusOf = async (id: string) => (await nrmsDb().execute<{ status: string }>(sql`SELECT status FROM outbox_deliveries WHERE event_id = ${id}`)).rows[0]!.status;

async function open(page: Page) {
  await page.goto(`${baseUrl()}/hub/undelivered-updates`);
  await expect(page.getByRole("heading", { level: 1, name: "Undelivered updates" })).toBeVisible();
}

test.describe("Undelivered updates", () => {
  let one: string;
  let published: string;
  let unpublished: string;
  let other: string;

  test.beforeAll(async () => {
    one = await deadInNrms("release.published", `release:${randomUUID()}`, 1, HEADLINE, 25);
    const withdrawn = `release:${randomUUID()}`;
    published = await deadInNrms("release.published", withdrawn, 1, WITHDRAWN, 27);
    unpublished = await deadInNrms("release.unpublished", withdrawn, 2, WITHDRAWN, 26);
    other = await deadInNrms("release.published", `release:${randomUUID()}`, 1, OTHER, 28);
    // Fix round 2, M4: a publish NoD never got, whose correction reached it first.
    const corrected = `release:${randomUUID()}`;
    await deadInNrms("release.published", corrected, 1, CORRECTED, 30);
    const correction = await deadInNrms("release.updated", corrected, 2, CORRECTED, 29);
    await nrmsDb().execute(sql`UPDATE outbox_deliveries SET status = 'delivered' WHERE event_id = ${correction}`);
  });

  test.afterAll(async () => {
    await nrmsDb().execute(sql`DELETE FROM outbox_events WHERE envelope -> 'data' ->> 'e2e' = ${TAG}`);
  });

  for (const width of [1280, 390]) {
    test(`lists the updates in plain words with no serious accessibility problems at ${width} px`, async ({ page, context }) => {
      await page.setViewportSize({ width, height: 900 });
      await signInAs(context, "admin");
      await open(page);
      const row = page.getByRole("row").filter({ hasText: HEADLINE });
      await expect(row).toContainText(`Release published: ${HEADLINE}`);
      await expect(row).toContainText("Subscribers (News On Demand)");
      await expect(row).toContainText("HTTP 503");
      const replaced = page.getByRole("row").filter({ hasText: `Release published: ${WITHDRAWN}` });
      await expect(replaced).toContainText("Replaced by a newer update: not sent again");
      await expect(replaced.getByRole("button", { name: /^Retry/ })).toHaveCount(0);
      const overtaken = page.getByRole("row").filter({ hasText: `Release published: ${CORRECTED}` });
      await expect(overtaken).toContainText("To send it, publish the release again from Releases.");
      await expect(overtaken.getByRole("button", { name: /^Retry/ })).toHaveCount(0);
      await expectNoSeriousA11yViolations(page, `/hub/undelivered-updates at ${width}`);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    });
  }

  test("Retry all asks first, and Cancel sends nothing", async ({ page, context }) => {
    await signInAs(context, "admin");
    await open(page);
    await page.getByRole("button", { name: /^Retry all \d+ from Releases$/ }).click();
    const dialog = page.getByRole("alertdialog");
    await expect(dialog).toContainText(/Resend \d+ updates? from Releases\?/);
    await expect(dialog).toContainText(/replaced by a newer update (isn't|aren't) sent/);
    await expect(dialog).toContainText("A Release published update emails its subscribers when it’s sent.");
    // The dialog's opening fade is mid-transition for a moment; axe reads the half-faded text as low contrast.
    await settleModalTransition(page);
    await expectNoSeriousA11yViolations(page, "/hub/undelivered-updates, Retry all question");
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toBeHidden();
    expect(await statusOf(one)).toBe("dead");
  });

  test("Retry puts one back in the queue and moves focus to what happened", async ({ page, context }) => {
    await signInAs(context, "admin");
    await open(page);
    await page.getByRole("button", { name: new RegExp(`^Retry Release published: ${HEADLINE}`) }).click();
    const said = page.getByRole("status").filter({ hasText: "Queued for delivery again." });
    await expect(said).toBeVisible();
    await expect(said).toBeFocused();
    // The e2e stack runs no loops (STACK_LOOPS=false) and this spec runs no tick, so it waits.
    expect(await statusOf(one)).toBe("pending");
  });

  test("Retry all resends the rest but never the replaced one", async ({ page, context }) => {
    await signInAs(context, "admin");
    await open(page);
    await page.getByRole("button", { name: /^Retry all \d+ from Releases$/ }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Resend" }).click();
    await expect(page.getByRole("status").filter({ hasText: /queued for delivery again/ })).toBeVisible();
    expect(await statusOf(published)).toBe("dead");
    expect(await statusOf(unpublished)).toBe("pending");
    expect(await statusOf(other)).toBe("pending");
  });

  test("Dismiss takes the replaced one off the list and records who did it", async ({ page, context }) => {
    await signInAs(context, "admin");
    await open(page);
    await page.getByRole("button", { name: new RegExp(`^Dismiss Release published: ${WITHDRAWN}`) }).click();
    await expect(page.getByRole("status").filter({ hasText: "Dismissed: it won't be sent." })).toBeVisible();
    expect(await statusOf(published)).toBe("dismissed");
    const dismissed = page.getByRole("table", { name: "Dismissed updates, most recent first" });
    await expect(dismissed.getByRole("row").filter({ hasText: WITHDRAWN })).toBeVisible();
    await expectNoSeriousA11yViolations(page, "/hub/undelivered-updates with dismissals");
  });
});

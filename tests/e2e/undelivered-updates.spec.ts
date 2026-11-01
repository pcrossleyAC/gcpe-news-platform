// Suite review O1.3 (owner 2026-10-31): the Hub's Undelivered updates screen, end to end. A delivery
// NoD "refused" is written straight into NRMS's outbox (the dispatcher takes 24 hours to give up on
// one for real), then a Core administrator sees it, at desktop and phone widths, and retries it.
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { expect, test } from "@playwright/test";
import { baseUrl, expectNoSeriousA11yViolations, nrmsDb, signInAs } from "./playwright-support";

const HEADLINE = `Undelivered e2e probe ${randomUUID().slice(0, 8)}`;

test.describe("Undelivered updates", () => {
  let eventId: string;

  test.beforeAll(async () => {
    eventId = randomUUID();
    const envelope = { id: eventId, type: "release.published", data: { key: `2026E2E-${eventId.slice(0, 6)}`, documents: [{ headline: HEADLINE }] } };
    await nrmsDb().execute(
      sql`INSERT INTO outbox_events (id, type, aggregate_id, sequence, envelope, created_at) VALUES (${eventId}, 'release.published', ${`release:${eventId}`}, 1, ${JSON.stringify(envelope)}::jsonb, now() - interval '25 hours')`,
    );
    await nrmsDb().execute(sql`INSERT INTO outbox_deliveries (event_id, subscriber, status, attempts, last_error) VALUES (${eventId}, 'nod', 'dead', 9, 'HTTP 503')`);
  });

  test.afterAll(async () => {
    await nrmsDb().execute(sql`DELETE FROM outbox_events WHERE id = ${eventId}`);
  });

  for (const width of [1280, 390]) {
    test(`lists the update in plain words with no serious accessibility problems at ${width} px`, async ({ page, context }) => {
      await page.setViewportSize({ width, height: 900 });
      await signInAs(context, "admin");
      await page.goto(`${baseUrl()}/hub/undelivered-updates`);
      await expect(page.getByRole("heading", { level: 1, name: "Undelivered updates" })).toBeVisible();
      const row = page.getByRole("row").filter({ hasText: HEADLINE });
      await expect(row).toContainText(`Release published: ${HEADLINE}`);
      await expect(row).toContainText("Subscribers (News On Demand)");
      await expect(row).toContainText("HTTP 503");
      await expectNoSeriousA11yViolations(page, `/hub/undelivered-updates at ${width}`);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    });
  }

  test("Retry puts it back in the queue", async ({ page, context }) => {
    await signInAs(context, "admin");
    await page.goto(`${baseUrl()}/hub/undelivered-updates`);
    await page.getByRole("button", { name: new RegExp(`^Retry Release published: ${HEADLINE}`) }).click();
    await expect(page.getByRole("status").filter({ hasText: "Queued for delivery again." })).toBeVisible();
    const { rows } = await nrmsDb().execute<{ status: string }>(sql`SELECT status FROM outbox_deliveries WHERE event_id = ${eventId}`);
    // The e2e stack runs no loops (STACK_LOOPS=false) and this spec runs no tick, so it waits.
    expect(rows[0]!.status).toBe("pending");
    await expect(page.getByText("Nothing is waiting: every update was delivered.")).toBeVisible();
  });
});

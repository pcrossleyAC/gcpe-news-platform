// Acceptance items 5 and 12 end to end: an alert posted to the (fake) emergency feed reaches an
// Emergency Info BC subscriber once; Operations shows the purge preview, and a night's purge
// removes exactly what it previewed.
import { test, expect } from "@playwright/test";
import { eq, sql } from "drizzle-orm";
import { nodSettings, subscribers } from "../../apps/nod/src/db/schema";
import { runPurgeIfDue } from "../../apps/nod/src/purge";
import { ADMIN_PASSWORD, ADMIN_USERNAME } from "./constants";
import {
  apiCall, baseUrl, ensureSubscriber, expectNoSeriousA11yViolations, fetchSentMessages, loginForCookie, nodDb, signInAs, tick, TENANT_TIME_ZONE, uniqueHeadline, waitForMessageTo,
} from "./playwright-support";

/** The feed's 5-minute gate, opened directly (the tick never takes a test clock). */
async function openFeedGate(): Promise<void> {
  await nodDb().update(nodSettings).set({ emergencyFeedCheckedAt: null }).where(eq(nodSettings.id, 1));
}

test.describe("emergency feed and retention purge", () => {
  test("an alert added to the feed reaches an Emergency Info BC subscriber, once", async () => {
    const adminCookie = await loginForCookie(ADMIN_USERNAME, ADMIN_PASSWORD);
    const email = `alerts-${Date.now()}@example.test`;
    await ensureSubscriber(adminCookie, email, ["emergency:alerts"]);

    // The first read of the feed records what is already there and sends nothing.
    await openFeedGate();
    await tick();

    const title = uniqueHeadline("Evacuation order");
    await apiCall(adminCookie, "/fake-emergency-feed/__fake/alerts", { method: "POST", body: { title, html: "<p>Leave now.</p><p>Route: Highway 1.</p>" } });
    await openFeedGate();
    await tick();
    const mail = await waitForMessageTo(`Emergency Info BC - ${title}`, email);
    expect(mail.text).toContain("Leave now.");
    expect(mail.text).toContain("Route: Highway 1.");
    expect(mail.headers["reply-to"]).toBeUndefined();

    await openFeedGate();
    await tick();
    await tick();
    expect((await fetchSentMessages()).filter((m) => m.subject === `Emergency Info BC - ${title}`)).toHaveLength(1);
  });

  test("Operations previews the purge; a night with it on removes exactly that, and nothing while off", async ({ page, context }) => {
    const adminCookie = await loginForCookie(ADMIN_USERNAME, ADMIN_PASSWORD);
    const db = nodDb();
    const email = `ended-${Date.now()}@example.test`;
    const [gone] = await db
      .insert(subscribers)
      .values({ email, status: "deleted", endedAt: sql`now() - interval '91 days'`, createdAt: sql`now() - interval '400 days'` })
      .returning({ id: subscribers.id });

    const before = await apiCall<{ purge: { enabled: boolean; preview: { endedSubscribers: number } } }>(adminCookie, "/nod/api/operations");
    expect(before.purge.enabled).toBe(false);
    expect(before.purge.preview.endedSubscribers).toBe(1);

    await signInAs(context, "admin");
    await page.goto(`${baseUrl()}/hub/subscribers/operations`);
    const section = page.getByRole("region", { name: "Retention purge" });
    await expect(section).toContainText("1 ended subscriber");
    await expectNoSeriousA11yViolations(page, "Operations with the purge section");

    // Off: a night passes and the record stays.
    const nextNight = () => {
      const t = new Date(Date.now() + 24 * 3_600_000);
      return () => t;
    };
    await db.update(nodSettings).set({ purgeDoneCutoff: null }).where(eq(nodSettings.id, 1));
    await runPurgeIfDue(db, TENANT_TIME_ZONE, { now: nextNight() });
    expect(await db.select().from(subscribers).where(eq(subscribers.id, gone!.id))).toHaveLength(1);

    await section.getByRole("button", { name: "Turn on the retention purge" }).click();
    const dialog = page.getByRole("alertdialog");
    await expect(dialog).toContainText("can’t be undone");
    await dialog.getByRole("button", { name: "Turn on purge" }).click();
    await expect(section.getByText("On", { exact: true })).toBeVisible();

    await db.update(nodSettings).set({ purgeDoneCutoff: null }).where(eq(nodSettings.id, 1));
    const result = await runPurgeIfDue(db, TENANT_TIME_ZONE, { now: nextNight() });
    expect(result.result?.counts.endedSubscribers).toBe(before.purge.preview.endedSubscribers);
    expect(await db.select().from(subscribers).where(eq(subscribers.id, gone!.id))).toHaveLength(0);

    await apiCall(adminCookie, "/nod/api/operations/purge", { method: "PUT", body: { enabled: false } });
  });
});

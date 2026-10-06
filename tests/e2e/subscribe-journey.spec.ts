// Phase 4 acceptance items 1–2: subscribe → verify → manage → unsubscribe, through the News
// API proxy and the test-site pages, with every email read back from the SMTP sink.
import { test, expect } from "@playwright/test";
import { baseUrl, expectNoSeriousA11yViolations, fetchSentMessages, tick } from "./playwright-support";

const VERIFY = "BC Gov News On Demand Email Verification";
const MANAGE = "BC Gov News On Demand Subscription Management";
const linkIn = (text: string | null) => text!.match(/https?:\/\/\S+token=[A-Za-z0-9_-]+/)![0];

async function newestTo(email: string, subject: string) {
  await expect.poll(async () => (await fetchSentMessages()).filter((m) => m.to.includes(email) && m.subject === subject).length).toBeGreaterThan(0);
  return (await fetchSentMessages()).filter((m) => m.to.includes(email) && m.subject === subject).at(-1)!;
}

test("subscribe, confirm, manage and unsubscribe through the test pages", async ({ page, request }) => {
  const email = `journey-${Date.now()}@example.test`;
  await tick(); // Core's reference data reaches NoD's lists
  await page.goto(`${baseUrl()}/site/subscribe/`);
  await expectNoSeriousA11yViolations(page, "subscribe page");
  await page.getByLabel("Email address").fill(email);
  await page.getByRole("checkbox", { name: "All news" }).check();
  await page.getByRole("button", { name: "Subscribe" }).click();
  await expect(page.getByRole("status")).toHaveText("Check your email to confirm your subscription.");
  await tick(); // Distribution sends

  await page.goto(linkIn((await newestTo(email, VERIFY)).text).replace(/^https?:\/\/[^/]+/, baseUrl()));
  await expect(page.getByRole("checkbox", { name: "All news" })).toBeChecked();
  await page.getByRole("checkbox", { name: "Daily digest" }).check();
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("status")).toHaveText("Your preferences are saved.");

  await page.getByRole("button", { name: "Unsubscribe" }).click();
  await page.getByRole("button", { name: "Unsubscribe" }).click();
  await expect(page.getByRole("status")).toHaveText("You're unsubscribed.");

  // I3: the page unsubscribe actually deactivated the subscriber — re-creating the same address
  // through the proxy must start a fresh verify journey, never a manage email, which would mean
  // the old row was still active.
  const recreate = await request.post(`${baseUrl()}/api/Subscribe/CreateNewsOnDemandEmailSubscriptionWithPreferences?api-version=1.0`, {
    data: { emailAddress: email, isAllNews: true, isAsItHappens: true, isDailyDigest: false, subscribedCategories: {} },
  });
  expect(recreate.status()).toBe(204);
  await tick();
  await expect.poll(async () => (await fetchSentMessages()).filter((m) => m.to.includes(email) && m.subject === VERIFY).length).toBe(2);
  expect((await fetchSentMessages()).filter((m) => m.to.includes(email) && m.subject === MANAGE)).toHaveLength(0);
});

test("manage link request and RFC 8058 one-click unsubscribe through the proxy prove the subscriber actually becomes inactive", async ({ request }) => {
  const email = `oneclick-${Date.now()}@example.test`;
  const body = { emailAddress: email, isAllNews: true, isAsItHappens: true, isDailyDigest: false, subscribedCategories: {} };
  await tick();
  await request.post(`${baseUrl()}/api/Subscribe/CreateNewsOnDemandEmailSubscriptionWithPreferences?api-version=1.0`, { data: body });
  await tick();
  const verifyToken = new URL(linkIn((await newestTo(email, VERIFY)).text)).searchParams.get("token");
  await request.get(`${baseUrl()}/api/Subscribe/ConfirmUpdateCreateSubscription/${verifyToken}?api-version=1.0`);

  // Item 2: ManageNewsOnDemandEmailSubscription for an active subscriber sends a Subscription
  // Management email; take its token.
  const manageRes = await request.get(`${baseUrl()}/api/Subscribe/ManageNewsOnDemandEmailSubscription/${encodeURIComponent(email)}?api-version=1.0`);
  expect(manageRes.status()).toBe(204);
  await tick();
  const manageToken = new URL(linkIn((await newestTo(email, MANAGE)).text)).searchParams.get("token");

  // Item 3: a real one-click unsubscribe POST — no api-version, RFC 8058 form body — through
  // the proxy.
  const oneClick = await request.post(`${baseUrl()}/api/Subscribe/OneClickUnsubscribe/${manageToken}`, {
    form: { "List-Unsubscribe": "One-Click" },
  });
  expect(oneClick.status()).toBe(200);
  expect(await oneClick.json()).toBe(true);

  // Prove it actually took effect: re-creating the address now starts a fresh verify journey,
  // never a manage email.
  await tick();
  const recreate = await request.post(`${baseUrl()}/api/Subscribe/CreateNewsOnDemandEmailSubscriptionWithPreferences?api-version=1.0`, { data: body });
  expect(recreate.status()).toBe(204);
  await tick();
  await expect.poll(async () => (await fetchSentMessages()).filter((m) => m.to.includes(email) && m.subject === VERIFY).length).toBe(2);
  expect((await fetchSentMessages()).filter((m) => m.to.includes(email) && m.subject === MANAGE)).toHaveLength(1); // only the one above
});

test("subscribe page stays usable at 320px wide", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 800 });
  await page.goto(`${baseUrl()}/site/subscribe/`);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
});

test("subscribing an address that's already subscribed looks identical and sends a manage email", async ({ page, request }) => {
  const email = `again-${Date.now()}@example.test`;
  const body = { emailAddress: email, isAllNews: true, isAsItHappens: true, isDailyDigest: false, subscribedCategories: {} };
  const url = `${baseUrl()}/api/Subscribe/CreateNewsOnDemandEmailSubscriptionWithPreferences?api-version=1.0`;
  const first = await request.post(url, { data: body });
  await tick();
  await request.get(`${baseUrl()}/api/Subscribe/ConfirmUpdateCreateSubscription/${new URL(linkIn((await newestTo(email, VERIFY)).text)).searchParams.get("token")}?api-version=1.0`);
  const second = await request.post(url, { data: body });
  expect([first.status(), second.status()]).toEqual([204, 204]);
  expect(await second.text()).toBe(await first.text());
  await tick();
  await newestTo(email, MANAGE);
  void page;
});

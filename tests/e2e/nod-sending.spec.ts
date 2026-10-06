// Acceptance items 3, 5 and 10: sending end to end. As-It-Happens goes out once and carries
// working per-recipient manage/one-click-unsubscribe links; an emergency item reaches a
// digest-only subscriber outside their own timing preference; pausing holds a release's send
// and resuming releases it.
import { test, expect } from "@playwright/test";
import { ADMIN_PASSWORD, ADMIN_USERNAME, EDITOR_EMAIL, TEST_USER_PASSWORDS } from "./constants";
import {
  apiCall,
  baseUrl,
  createApprovedAndPublished,
  ensureSubscriber,
  fetchSentMessages,
  loginForCookie,
  tick,
  uniqueHeadline,
  waitForMessageTo,
  type SentMessage,
} from "./playwright-support";

const VERIFY = "BC Gov News On Demand Email Verification";

const linkIn = (text: string | null) => text!.match(/https?:\/\/\S+\/subscribe\/manage\/\?token=[A-Za-z0-9_-]+/)![0];
const toBaseUrl = (url: string) => url.replace(/^https?:\/\/[^/]+/, baseUrl());

async function messagesWithSubject(subject: string): Promise<SentMessage[]> {
  return (await fetchSentMessages()).filter((m) => m.subject === subject);
}

async function createAndConfirm(request: import("@playwright/test").APIRequestContext, body: Record<string, unknown>): Promise<void> {
  const email = body.emailAddress as string;
  await request.post(`${baseUrl()}/api/Subscribe/CreateNewsOnDemandEmailSubscriptionWithPreferences?api-version=1.0`, { data: body });
  await tick();
  const mail = await waitForMessageTo(VERIFY, email);
  const token = new URL(linkIn(mail.text)).searchParams.get("token");
  const res = await request.get(`${baseUrl()}/api/Subscribe/ConfirmUpdateCreateSubscription/${token}?api-version=1.0`);
  expect(res.status()).toBe(200);
}

test.describe("item 3/5/10: NoD sending end to end", () => {
  test("as-it-happens sends once, its links work, and a tick never resends it", async ({ page, request }) => {
    const editorCookie = await loginForCookie(EDITOR_EMAIL, TEST_USER_PASSWORDS[EDITOR_EMAIL]!);
    const email = `aih-${Date.now()}@example.test`;
    await createAndConfirm(request, { emailAddress: email, isAllNews: true, isAsItHappens: true, isDailyDigest: false, subscribedCategories: {} });

    const headline = uniqueHeadline("NoD sending end to end");
    await createApprovedAndPublished(editorCookie, { headline });
    await tick();

    const subject = `BC Gov News - ${headline}`;
    const mail = await waitForMessageTo(subject, email);
    expect(await messagesWithSubject(subject)).toHaveLength(1);

    // The manage link in the body shows this subscriber's current preferences.
    await page.goto(toBaseUrl(linkIn(mail.text)));
    await expect(page.getByRole("checkbox", { name: "All news" })).toBeChecked();
    await expect(page.getByRole("checkbox", { name: "As it happens" })).toBeChecked();

    // RFC 8058 one-click unsubscribe, through the List-Unsubscribe header this email carries.
    expect(mail.headers["list-unsubscribe-post"]).toBe("List-Unsubscribe=One-Click");
    const unsubscribeUrl = toBaseUrl(mail.headers["list-unsubscribe"]!.replace(/^<|>$/g, ""));
    const oneClick = await request.post(unsubscribeUrl, { form: { "List-Unsubscribe": "One-Click" } });
    expect(oneClick.status()).toBe(200);
    expect(await oneClick.json()).toBe(true);

    // Prove it actually took effect: re-creating the same address starts a fresh verify
    // journey (an active subscriber would instead get a manage email).
    const recreate = await request.post(`${baseUrl()}/api/Subscribe/CreateNewsOnDemandEmailSubscriptionWithPreferences?api-version=1.0`, {
      data: { emailAddress: email, isAllNews: true, isAsItHappens: true, isDailyDigest: false, subscribedCategories: {} },
    });
    expect(recreate.status()).toBe(204);
    await tick();
    await expect.poll(async () => (await fetchSentMessages()).filter((m) => m.subject === VERIFY && m.to.includes(email)).length).toBe(2);

    // Still exactly one As-It-Happens email for this release.
    await tick();
    expect(await messagesWithSubject(subject)).toHaveLength(1);
  });

  test("an emergency item reaches a digest-only subscriber on an admin POST", async ({ request }) => {
    const adminCookie = await loginForCookie(ADMIN_USERNAME, ADMIN_PASSWORD);
    const email = `emergency-${Date.now()}@example.test`;
    await createAndConfirm(request, { emailAddress: email, subscribedCategories: { emergency: ["alerts"] }, isDailyDigest: true });

    const title = uniqueHeadline("Province-wide emergency alert");
    await apiCall(adminCookie, "/nod/api/emergency-items", {
      method: "POST",
      body: { guid: `emergency-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, title, url: "https://example.test/alert" },
    });
    await tick();

    const subject = `Emergency Info BC - ${title}`;
    await waitForMessageTo(subject, email);
  });

  test("pause holds a release's send; resume releases it", async ({ request }) => {
    const adminCookie = await loginForCookie(ADMIN_USERNAME, ADMIN_PASSWORD);
    const editorCookie = await loginForCookie(EDITOR_EMAIL, TEST_USER_PASSWORDS[EDITOR_EMAIL]!);
    const email = `pause-${Date.now()}@example.test`;
    // A ministry key of its own (not "health", which publish-email.spec.ts's own subscriber
    // also sits on) — this subscriber outlives the test (the admin API has no delete), so it
    // must never go on to match another spec's "ministries:health" release.
    await ensureSubscriber(adminCookie, email, ["ministries:finance"]);

    const pauseRes = await apiCall<{ paused: boolean }>(adminCookie, "/nod/api/settings/pause", { method: "POST" });
    expect(pauseRes.paused).toBe(true);
    try {
      const headline = uniqueHeadline("Paused sending test");
      await createApprovedAndPublished(editorCookie, { headline, ministries: ["finance"], leadMinistryKey: "finance" });
      await tick();
      const subject = `BC Gov News - ${headline}`;
      expect(await messagesWithSubject(subject)).toHaveLength(0);

      const resumeRes = await apiCall<{ paused: boolean }>(adminCookie, "/nod/api/settings/resume", { method: "POST" });
      expect(resumeRes.paused).toBe(false);
      await tick();
      await waitForMessageTo(subject, email);
      expect(await messagesWithSubject(subject)).toHaveLength(1);
    } finally {
      await apiCall(adminCookie, "/nod/api/settings/resume", { method: "POST" });
    }
  });
});

// Acceptance item 9: bounces end to end (task-6-brief.md). A hard-bounced subscriber's
// delivery is marked, ten hard-bounced emails in fifteen days disables them (never deleted —
// Global Constraints "disabled" defined), the next release doesn't reach them, and the next
// daily summary reports it.
//
// Two of distribution's own self-gates stand between this one test and a deterministic run,
// and neither has a production-facing override: `distribution.bounces`' 15-minute gate
// (distribution_settings.bounces_checked_at) and the daily bounce summary's 08:00-BC-time gate
// (nod_settings.bounce_summary_*). Both are bypassed the same way flickr-outage.spec.ts bypasses
// a timing gate the stack doesn't expose a test clock for: a direct connection to the same test
// database (distDb()/nodDb()). The bounce summary goes one step further — its own due check
// reads the database's real `now()`, which this suite has no way to move, so this test calls
// `runBounceSummaryIfDue` directly with the `TestClock` hook it already takes for its own unit
// tests (bounce-summary.ts), against the live stack's own NoD database and a Distribution
// client built the same way NoD's own (local-mode) one is (distribution-token.ts) — the actual
// summary send still goes out through the real Distribution HTTP API and the real SMTP sink,
// only the "is it due yet" clock is faked.
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { test, expect, type APIRequestContext } from "@playwright/test";
import { mintLocalToken } from "@gcpe/auth";
import { ADMIN_PASSWORD, ADMIN_USERNAME, BOUNCE_SUMMARY_EMAIL, EDITOR_EMAIL, LOCAL_AUTH_SECRET, NEWS_REPLY_TO, TEST_USER_PASSWORDS } from "./constants";
import {
  apiCall,
  baseUrl,
  createApprovedAndPublished,
  distDb,
  fetchSentMessages,
  loginForCookie,
  nodDb,
  TENANT_TIME_ZONE,
  tick,
  tickTwice,
  uniqueHeadline,
  waitForMessageTo,
} from "./playwright-support";
import { distributionClient } from "../../apps/nod/src/distribution-client";
import { BOUNCE_SUMMARY_HOUR, runBounceSummaryIfDue } from "../../apps/nod/src/bounce-summary";
import { todaysCutoff } from "../../apps/nod/src/digest";

const VERIFY = "BC Gov News On Demand Email Verification";
const linkIn = (text: string | null) => text!.match(/https?:\/\/\S+\/subscribe\/manage\/\?token=[A-Za-z0-9_-]+/)![0];

async function subscribeAndConfirm(request: APIRequestContext, email: string): Promise<void> {
  await request.post(`${baseUrl()}/api/Subscribe/CreateNewsOnDemandEmailSubscriptionWithPreferences?api-version=1.0`, {
    data: { emailAddress: email, isAllNews: true, isAsItHappens: true, isDailyDigest: false, subscribedCategories: {} },
  });
  await tick();
  const mail = await waitForMessageTo(VERIFY, email);
  const token = new URL(linkIn(mail.text)).searchParams.get("token");
  const res = await request.get(`${baseUrl()}/api/Subscribe/ConfirmUpdateCreateSubscription/${token}?api-version=1.0`);
  expect(res.status()).toBe(200);
}

/** Publishes one more As-It-Happens release to `email` and returns the exact `Message-ID`
 * Distribution's sender stamped on it (sender.ts's `messageIdFor`) — read back from the SMTP
 * sink, the same place a real mail server reading a bounce back would have gotten it from. */
async function publishAndCaptureMessageId(editorCookie: string, email: string, n: number): Promise<string> {
  const headline = uniqueHeadline(`Bounce test ${n}`);
  await createApprovedAndPublished(editorCookie, { headline });
  const mail = await waitForMessageTo(`BC Gov News - ${headline}`, email);
  const messageId = mail.headers["message-id"];
  if (!messageId) throw new Error(`no Message-ID header on the release ${n} email to ${email}`);
  return messageId;
}

/** The `Status:`/`Diagnostic-Code:` pair for each status {@link buildBounceEml} is asked to
 * produce — just the two this suite ever uploads: the default hard bounce, and one soft code. */
const BOUNCE_DIAGNOSTICS: Record<string, string> = {
  "5.1.1": "550 5.1.1 The email account that you tried to reach does not exist.",
  "4.2.2": "452 4.2.2 Mailbox full",
};

/** An RFC 3464 delivery-status bounce for `messageId`/`recipient`, the same shape as
 * apps/distribution/test/fixtures/bounces/gmail-dsn.eml (already unit-tested against
 * parseBounce) — hard (`5.1.1`) by default, with the original message's own Message-ID attached
 * so matching is by Message-ID (Global Constraints "Matching" §1), never the recipient
 * fallback. `status` drives both the `Status:` field and the `Diagnostic-Code:` text. */
function buildBounceEml(recipient: string, messageId: string, status = "5.1.1"): string {
  const boundary = `E2E-BOUNCE-${randomUUID()}`;
  const now = new Date().toUTCString();
  const diagnostic = BOUNCE_DIAGNOSTICS[status];
  if (!diagnostic) throw new Error(`buildBounceEml: no diagnostic text configured for status ${status}`);
  return [
    "From: Mail Delivery Subsystem <mailer-daemon@mail.example.test>",
    "To: distribution@example.test",
    "Subject: Delivery Status Notification (Failure)",
    `Date: ${now}`,
    `Content-Type: multipart/report; report-type=delivery-status;`,
    `\tboundary="${boundary}"`,
    "MIME-Version: 1.0",
    "",
    `--${boundary}`,
    `Content-Type: text/plain; charset="UTF-8"`,
    "",
    "Delivery to the following recipient failed permanently:",
    "",
    `    ${recipient}`,
    "",
    `--${boundary}`,
    "Content-Type: message/delivery-status",
    "",
    "Reporting-MTA: dns;mail.example.test",
    `Arrival-Date: ${now}`,
    "",
    `Final-Recipient: rfc822; ${recipient}`,
    "Action: failed",
    `Status: ${status}`,
    `Diagnostic-Code: smtp; ${diagnostic}`,
    "",
    `--${boundary}`,
    "Content-Type: message/rfc822",
    "",
    "Return-Path: <releases@example.test>",
    "From: releases@example.test",
    `To: ${recipient}`,
    "Subject: BC Gov News bounce test item",
    `Date: ${now}`,
    `Message-ID: ${messageId}`,
    `Content-Type: text/plain; charset="UTF-8"`,
    "",
    "Original message body.",
    "",
    `--${boundary}--`,
    "",
  ].join("\r\n");
}

/** `POST /nod/api/bounces/inbox` (NoD.Admin) — NoD's own proxy into Distribution's fake inbox. */
async function uploadBounce(adminCookie: string, recipient: string, messageId: string, status = "5.1.1"): Promise<void> {
  await apiCall(adminCookie, "/nod/api/bounces/inbox", { method: "POST", body: { raw: buildBounceEml(recipient, messageId, status) } });
}

/** Bypasses distribution.bounces' own 15-minute gate (apps/distribution/src/bounces/run.ts's
 * `claimBounceGate`) so the very next tick claims it fresh, regardless of whether some earlier,
 * unrelated tick elsewhere in this suite already claimed it moments ago. */
async function resetBounceGate(): Promise<void> {
  await distDb().execute(sql`UPDATE distribution_settings SET bounces_checked_at = NULL WHERE id = 1`);
}

async function hardBouncedCount(email: string): Promise<number> {
  const { rows } = await nodDb().execute<{ count: number }>(sql`
    SELECT count(*)::int AS count
      FROM deliveries d
      JOIN subscribers s ON s.id = d.subscriber_id
     WHERE lower(s.email) = ${email.toLowerCase()} AND d.hard_bounced_at IS NOT NULL
  `);
  return rows[0]?.count ?? 0;
}

async function subscriberStatus(email: string): Promise<string | null> {
  const { rows } = await nodDb().execute<{ status: string }>(sql`SELECT status FROM subscribers WHERE lower(email) = ${email.toLowerCase()}`);
  return rows[0]?.status ?? null;
}

/** Resets the daily bounce summary's own gate (nod_settings.bounce_summary_*) so the direct
 * `runBounceSummaryIfDue` call below is claimed fresh, regardless of whether some earlier,
 * unrelated tick elsewhere in this suite already checked today's cutoff for real (see this
 * file's own header comment). */
async function resetBounceSummaryGate(): Promise<void> {
  await nodDb().execute(sql`
    UPDATE nod_settings
       SET bounce_summary_at = NULL, bounce_summary_checked_at = NULL, bounce_summary_lease = NULL, bounce_summary_lease_until = NULL
     WHERE id = 1
  `);
}

/** A `TestClock` safely past today's 08:00 BC cutoff *and* past the real current instant —
 * see this file's own header comment for why neither "today's cutoff" nor "tomorrow's cutoff"
 * alone works at every real time of day the suite might happen to run at. Whichever is later:
 * a real clock reading one minute from now (always after every real bounce timestamp this test
 * just wrote), or today's cutoff five minutes in (always at or past due, and, when the real
 * wall clock is already past 08:00 BC, also after every real bounce timestamp this test wrote —
 * exactly one of the two guarantees is ever the binding one). */
function pastBounceSummaryCutoff(): Date {
  const r = new Date();
  const cutoffPlus5 = new Date(todaysCutoff(r, TENANT_TIME_ZONE, BOUNCE_SUMMARY_HOUR).getTime() + 5 * 60_000);
  const rPlus1 = new Date(r.getTime() + 60_000);
  return cutoffPlus5.getTime() > rPlus1.getTime() ? cutoffPlus5 : rPlus1;
}

/** Tomorrow's cutoff (fixed by calendar date, not by how far off real "now" happens to be) —
 * this suite's own first test already claims and sends *today's* summary, and
 * `distribution.send`'s idempotency key is keyed only by calendar day
 * (`nod-bounce-summary-<dateLabel>`, bounce-summary.ts), shared by every call on the same day
 * regardless of how many times the gate is reset. A second real send within this run needs a
 * cutoff on a different day, or it is silently deduped against the batch the first test
 * already sent, with none of this test's own content in it.
 *
 * Unlike {@link pastBounceSummaryCutoff}, this has no real-clock fallback branch: the window's
 * own start (`dbNow` minus 24h, when `bounce_summary_at` is reset to null — see
 * `resetBounceSummaryGate`) must still land before this test's own bounce was processed, which
 * only holds when the suite runs after today's cutoff hour (08:00 BC) — true for any normal
 * working-hours run, the same assumption `pastBounceSummaryCutoff`'s own comment already
 * documents for the opposite direction. */
function pastNextBounceSummaryCutoff(): Date {
  const tomorrow = new Date(Date.now() + 24 * 3_600_000);
  return new Date(todaysCutoff(tomorrow, TENANT_TIME_ZONE, BOUNCE_SUMMARY_HOUR).getTime() + 5 * 60_000);
}

/** A Distribution client authenticated exactly the way NoD's own (local-mode) one is
 * (apps/nod/src/distribution-token.ts) — minted directly here since this call bypasses NoD's
 * own process entirely (it's this test, not NoD, invoking bounce-summary.ts's exported
 * function against the live stack's Distribution app over HTTP). */
async function distributionClientForSummary() {
  const token = await mintLocalToken({ secret: LOCAL_AUTH_SECRET, subject: "e2e-bounce-summary", azp: "nod", roles: ["Distribution.Send", "Distribution.Operate"] });
  return distributionClient({ baseUrl: `${baseUrl()}/distribution`, getToken: async () => token });
}

test.describe("item 9: bounces end to end", () => {
  test("ten hard bounces in 15 days disables the subscriber, stops sending to them, and is reported in the next daily summary", async ({ request }) => {
    test.setTimeout(120_000);

    const adminCookie = await loginForCookie(ADMIN_USERNAME, ADMIN_PASSWORD);
    const editorCookie = await loginForCookie(EDITOR_EMAIL, TEST_USER_PASSWORDS[EDITOR_EMAIL]!);
    const email = `bounce-${Date.now()}@example.test`;

    await subscribeAndConfirm(request, email);

    // 1 of 10: publish, bounce it, and prove the single-bounce path (upload -> tick ->
    // hard_bounced_at) before seeding the rest.
    const firstMessageId = await publishAndCaptureMessageId(editorCookie, email, 1);
    await resetBounceGate();
    await uploadBounce(adminCookie, email, firstMessageId);
    await tickTwice();
    expect(await hardBouncedCount(email)).toBe(1);
    expect(await subscriberStatus(email)).toBe("active");

    // 2..10: nine more releases, each bounced the same way, uploaded together — the 15-minute
    // gate only lets one wave through per real claim, so it's reset once more for this wave
    // rather than waiting out 15 real minutes between ten separate uploads.
    for (let n = 2; n <= 10; n++) {
      const messageId = await publishAndCaptureMessageId(editorCookie, email, n);
      await uploadBounce(adminCookie, email, messageId);
    }
    await resetBounceGate();
    await tickTwice();
    expect(await hardBouncedCount(email)).toBe(10);
    expect(await subscriberStatus(email)).toBe("disabled");

    // The next release doesn't reach them.
    const unreached = uniqueHeadline("Bounce test unreached");
    await createApprovedAndPublished(editorCookie, { headline: unreached });
    await tick();
    expect((await fetchSentMessages()).filter((m) => m.subject === `BC Gov News - ${unreached}` && m.to.includes(email))).toHaveLength(0);

    // The next daily summary reports it (test hook — see this file's own header comment).
    await resetBounceSummaryGate();
    const clock = pastBounceSummaryCutoff();
    const distribution = await distributionClientForSummary();
    const result = await runBounceSummaryIfDue(nodDb(), distribution, TENANT_TIME_ZONE, BOUNCE_SUMMARY_EMAIL, () => clock);
    expect(result.sent).toBe(true);
    expect(result.lines).toBeGreaterThanOrEqual(1);

    const dateLabel = new Intl.DateTimeFormat("en-CA", { timeZone: TENANT_TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit" }).format(
      todaysCutoff(clock, TENANT_TIME_ZONE, BOUNCE_SUMMARY_HOUR),
    );
    const subject = `News On Demand - Bounce Manager - ${dateLabel}`;
    await tickTwice();
    const summaryMails = (await fetchSentMessages()).filter((m) => m.subject === subject && m.to.includes(BOUNCE_SUMMARY_EMAIL));
    expect(summaryMails).toHaveLength(1);
    expect(summaryMails[0]!.text).toContain(email);
    expect(summaryMails[0]!.text).toContain("disabled (10/15d)");
  });

  test("a soft bounce is listed in the summary with its code and message, and the release replied to NOD_REPLY_TO", async ({ request }) => {
    test.setTimeout(90_000);
    const adminCookie = await loginForCookie(ADMIN_USERNAME, ADMIN_PASSWORD);
    const editorCookie = await loginForCookie(EDITOR_EMAIL, TEST_USER_PASSWORDS[EDITOR_EMAIL]!);
    const email = `soft-${Date.now()}@example.test`;
    await subscribeAndConfirm(request, email);

    const verify = await waitForMessageTo(VERIFY, email);
    expect(verify.headers["reply-to"]).toBeUndefined();

    const headline = uniqueHeadline("Soft bounce test");
    await createApprovedAndPublished(editorCookie, { headline });
    const mail = await waitForMessageTo(`BC Gov News - ${headline}`, email);
    expect(mail.headers["reply-to"]).toContain(NEWS_REPLY_TO);

    await resetBounceGate();
    await uploadBounce(adminCookie, email, mail.headers["message-id"]!, "4.2.2");
    await tickTwice();

    await resetBounceSummaryGate();
    const clock = pastNextBounceSummaryCutoff();
    const result = await runBounceSummaryIfDue(nodDb(), await distributionClientForSummary(), TENANT_TIME_ZONE, BOUNCE_SUMMARY_EMAIL, () => clock);
    expect(result.sent).toBe(true);
    await tickTwice();
    const summary = (await fetchSentMessages()).filter((m) => m.subject?.startsWith("News On Demand - Bounce Manager - ") && m.to.includes(BOUNCE_SUMMARY_EMAIL)).at(-1)!;
    expect(summary.text).toContain(`${email} (4.2.2 452 4.2.2 Mailbox full) - BC Gov News - ${headline}`);

    // A soft bounce alone never disables a subscriber (it doesn't count toward 10-in-15-days),
    // so without this, an All News/As-It-Happens subscriber would stay active and keep
    // receiving every release the rest of this suite publishes afterwards.
    await nodDb().execute(sql`UPDATE subscribers SET status = 'disabled' WHERE lower(email) = ${email.toLowerCase()}`);
  });
});

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq, isNull, sql } from "drizzle-orm";
import type { TestDatabase } from "@gcpe/db-kit";
import { indexKeysFor } from "@gcpe/events";
import { sampleRelease } from "@gcpe/events/testing";
import { createNodTestDb } from "../test/helpers";
import { createItemSending } from "./as-it-happens";
import { correctionAudience, createCorrectionSends, type CorrectionRequest } from "./correction";
import { deliveries, lists, nodSettings, operationsLog, sendJobs, subscribers } from "./db/schema";
import { digestCutoff, runDigestIfDue } from "./digest";
import type { DistributionClient } from "./distribution-client";
import { refreshReleaseItem, upsertReleaseItem, withdrawItem } from "./items";
import { addMediaMember } from "./media-members";
import { createMediaSend } from "./media-send";
import { cancelHeldEmail, getOutgoing } from "./outgoing";
import type { RecipientLinkOptions } from "./recipient-links";
import { sendDueJobs } from "./send-jobs";
import { addSubscriber } from "./subscribers";

const RENDER = { siteUrl: "https://news.example", bannerUrl: null };
const LINKS: RecipientLinkOptions = {
  pageUrl: "https://news.example/subscribe/manage",
  subscribeApiUrl: "https://news.example/api/Subscribe",
  linkSecret: "test-link-secret-at-least-32-chars-long",
};
const TZ = "America/Vancouver";
const HOUR_MS = 3_600_000;
const mk = "ministries:transportation-and-transit";
const MEDIA = ["media-distribution-lists:budget", "media-distribution-lists:retired"];

/**
 * Owner decision 2026-10-31: a republish can email a corrected copy, "Corrected: " before the
 * subject, to the people who already got the release, per tick (subscribers: As it happens or
 * the daily digest; media lists), one copy each, the media copy winning. Each case runs the
 * release's real first send (media, As-It-Happens, the 5 pm digest, then the sender handing it
 * all to a fake Distribution), changes who is still subscribed, then compares the dialog's counts
 * ({@link correctionAudience}) with the corrected copies {@link createCorrectionSends} creates.
 */
describe("corrected copies", () => {
  let tdb: TestDatabase;
  const sent: { subject: string; html: string; emails: string[]; idempotencyKey?: string }[] = [];
  const distribution = {
    send: async (m: { subject: string; html: string; recipients: { email: string }[]; idempotencyKey?: string }) => {
      sent.push({ subject: m.subject, html: m.html, emails: m.recipients.map((r) => r.email).sort(), idempotencyKey: m.idempotencyKey });
      return { batchId: "00000000-0000-4000-8000-0000000000ab" };
    },
  } as unknown as DistributionClient;

  beforeAll(async () => {
    tdb = await createNodTestDb();
  });
  afterAll(async () => {
    await tdb.drop();
  });
  beforeEach(async () => {
    sent.length = 0;
    await tdb.pool.query("TRUNCATE deliveries, send_jobs, job_recipients, items, digest_runs, subscriptions, subscribers, lists, operations_log CASCADE");
  });

  const release = {
    ...sampleRelease,
    publishFlags: { ...sampleRelease.publishFlags, toSubscribers: true, toMediaLists: true },
    mediaListKeys: ["budget", "retired"],
    mediaText: "The original media text.",
  };
  const audienceInput = { itemKey: release.key, listKeys: indexKeysFor(release), mediaListKeys: MEDIA };
  const request = (over: Partial<CorrectionRequest> = {}): CorrectionRequest => ({
    seq: 1,
    subscribers: true,
    mediaLists: true,
    requestedBy: "Pat Editor",
    requestedAt: "2026-10-31T21:15:00.000Z",
    ...over,
  });

  /** Subscribers, then the release's whole first send, every email handed to Distribution. */
  async function firstSend(): Promise<void> {
    const db = tdb.db;
    await db.insert(lists).values([
      { listKey: "media-distribution-lists:budget", category: "media-distribution-lists", key: "budget", name: "Budget", active: true },
      { listKey: "media-distribution-lists:retired", category: "media-distribution-lists", key: "retired", name: "Retired", active: false },
    ]);
    await addSubscriber(db, { email: "aih@x.test", lists: [mk] });
    await addSubscriber(db, { email: "digestonly@x.test", lists: [mk], asItHappens: false, digest: true });
    await addSubscriber(db, { email: "both@x.test", lists: "all", asItHappens: true, digest: true });
    await addSubscriber(db, { email: "nomatch@x.test", lists: ["sectors:mining"], asItHappens: true, digest: true });
    await addSubscriber(db, { email: "pubmedia@x.test", lists: [mk] });
    await addSubscriber(db, { email: "mediadigest@x.test", lists: [mk], asItHappens: false, digest: true });
    await addSubscriber(db, { email: "leaver@x.test", lists: [mk] });
    await addSubscriber(db, { email: "paused@x.test", lists: [mk] });
    await addMediaMember(db, "budget", { email: "pubmedia@x.test", source: "manual-media" }, "t");
    await addMediaMember(db, "budget", { email: "mediaonly@x.test", source: "manual-media" }, "t");
    await addMediaMember(db, "budget", { email: "mediadigest@x.test", source: "manual-media" }, "t");
    await addMediaMember(db, "budget", { email: "medialeaver@x.test", source: "manual-media" }, "t");
    await addMediaMember(db, "retired", { email: "retiredmedia@x.test", source: "manual-media" }, "t");

    const cutoff = digestCutoff(new Date(), TZ);
    await db.update(nodSettings).set({ lastDigestCutoff: new Date(cutoff.getTime() - 24 * HOUR_MS), paused: false }).where(eq(nodSettings.id, 1));
    const { createItemSend } = createItemSending({ render: RENDER });
    await db.transaction(async (tx) => {
      await upsertReleaseItem(tx, { ...release, publishDate: new Date(cutoff.getTime() - HOUR_MS).toISOString() }, RENDER.siteUrl);
      await createMediaSend(tx, release.key, RENDER);
      await createItemSend(tx, release.key, "as_it_happens");
    });
    await runDigestIfDue(db, TZ, RENDER);
    // "paused@" never got it: their As-It-Happens delivery is recorded but never handed off, as
    // if it were still waiting in a paused queue.
    const paused = await db.select({ id: subscribers.id }).from(subscribers).where(eq(subscribers.email, "paused@x.test"));
    await db.execute(sql`DELETE FROM job_recipients WHERE subscriber_id = ${paused[0]!.id}`);
    await sendDueJobs({ db, distribution, links: LINKS, render: RENDER });
    const unsent = await db.select({ id: deliveries.subscriberId }).from(deliveries).where(and(eq(deliveries.itemKey, release.key), isNull(deliveries.attemptedAt)));
    expect(unsent).toEqual([{ id: paused[0]!.id }]);
    sent.length = 0;

    // Since the first send: one subscriber and one media contact unsubscribed, one subscriber was
    // disabled, and a new subscriber arrived who never got it.
    await db.update(subscribers).set({ status: "deleted" }).where(eq(subscribers.email, "leaver@x.test"));
    await db.update(subscribers).set({ status: "deleted" }).where(eq(subscribers.email, "medialeaver@x.test"));
    await db.update(subscribers).set({ status: "disabled" }).where(eq(subscribers.email, "nomatch@x.test"));
    await addSubscriber(db, { email: "newcomer@x.test", lists: [mk], asItHappens: true, digest: true });
  }

  /** Who the corrected copies of correction `seq` go to, by job kind. */
  async function corrected(seq = 1): Promise<Record<string, string[]>> {
    const { rows } = await tdb.db.execute<{ kind: string; email: string }>(sql`
      SELECT j.kind, s.email FROM deliveries d JOIN send_jobs j ON j.id = d.job_id JOIN subscribers s ON s.id = d.subscriber_id
       WHERE d.mode = 'correction' AND d.correction = ${seq} ORDER BY s.email`);
    const out: Record<string, string[]> = {};
    for (const r of rows) (out[r.kind] ??= []).push(r.email);
    return out;
  }

  it("the dialog's counts equal the corrected copies created, for each choice of ticks", async () => {
    await firstSend();
    const audience = await correctionAudience(tdb.db, audienceInput);
    // Subscribers who got it and are still on it: aih, both, digestonly, mediadigest (leaver
    // unsubscribed, nomatch disabled, paused never got it, newcomer is new). Media contacts who got
    // it: pubmedia, mediaonly, mediadigest (medialeaver unsubscribed; the retired list got nothing).
    expect(audience).toEqual({ subscribers: 4, mediaContacts: 3, both: 1 });

    for (const [i, ticks] of [
      { subscribers: true, mediaLists: false },
      { subscribers: false, mediaLists: true },
      { subscribers: true, mediaLists: true },
    ].entries()) {
      const seq = i + 1;
      const made = await tdb.db.transaction((tx) => createCorrectionSends(tx, release.key, request({ seq, ...ticks }), RENDER));
      const copies = await corrected(seq);
      const subs = copies.correction ?? [];
      const media = copies.correction_media ?? [];
      // One copy per person: the media copy wins for someone in both.
      expect(new Set([...subs, ...media]).size).toBe(subs.length + media.length);
      expect(media.length).toBe(ticks.mediaLists ? audience.mediaContacts : 0);
      expect(subs.length).toBe(ticks.subscribers ? audience.subscribers - (ticks.mediaLists ? audience.both : 0) : 0);
      expect(made).toEqual({ subscribers: subs.length, mediaContacts: media.length });
    }
    expect(await corrected(3)).toEqual({
      correction: ["aih@x.test", "both@x.test", "digestonly@x.test"],
      correction_media: ["mediadigest@x.test", "mediaonly@x.test", "pubmedia@x.test"],
    });
  });

  it("sends the current content with 'Corrected: ' before the subject, each correction its own send", async () => {
    await firstSend();
    // The corrected release, as release.updated refreshes it before the copies are made.
    await refreshReleaseItem(tdb.db, { ...release, documents: [{ ...release.documents[0]!, headline: "Corrected headline" }], mediaText: "The corrected media text." }, RENDER.siteUrl);
    await tdb.db.transaction((tx) => createCorrectionSends(tx, release.key, request(), RENDER));
    await sendDueJobs({ db: tdb.db, distribution, links: LINKS, render: RENDER });
    const subjects = sent.map((m) => m.subject).sort();
    expect(subjects).toEqual(["Corrected: BC Gov News - Corrected headline", "Corrected: BC Gov News - Corrected headline"]);
    const media = sent.find((m) => m.emails.includes("mediaonly@x.test"))!;
    expect(media.html).toContain("The corrected media text.");
    expect(media.html).not.toContain("The original media text.");
    const subs = sent.find((m) => m.emails.includes("aih@x.test"))!;
    expect(subs.html).toContain("Corrected headline");

    // The same correction again (a redelivered event) adds nothing; a second correction is a new send.
    const again = await tdb.db.transaction((tx) => createCorrectionSends(tx, release.key, request(), RENDER));
    expect(again).toEqual({ subscribers: 0, mediaContacts: 0 });
    await tdb.db.transaction((tx) => createCorrectionSends(tx, release.key, request({ seq: 2 }), RENDER));
    const keys = (await tdb.db.select({ k: sendJobs.jobKey }).from(sendJobs).where(eq(sendJobs.kind, "correction"))).map((r) => r.k).sort();
    expect(keys).toEqual([`correction:1:as_it_happens:${release.key}`, `correction:2:as_it_happens:${release.key}`]);
  });

  it("an advisory's corrected copy keeps its bare-title media subject", async () => {
    await firstSend();
    await tdb.db.execute(sql`UPDATE items SET post_kind = 'advisories' WHERE key = ${release.key}`);
    await tdb.db.transaction((tx) => createCorrectionSends(tx, release.key, request({ subscribers: false }), RENDER));
    await sendDueJobs({ db: tdb.db, distribution, links: LINKS, render: RENDER });
    expect(sent.map((m) => m.subject)).toEqual([`Corrected: ${release.documents[0]!.headline}`]);
  });

  it("records who asked and when in the NoD log", async () => {
    await firstSend();
    await tdb.db.transaction((tx) => createCorrectionSends(tx, release.key, request(), RENDER));
    const log = await tdb.db.select().from(operationsLog);
    expect(log.map((l) => [l.actor, l.action])).toEqual([["Pat Editor", "correction-emailed"]]);
    expect(log[0]!.detail).toBe(`${release.key} "${release.documents[0]!.headline}", correction 1, asked for at 2026-10-31T21:15:00.000Z: 3 subscribers, 3 media contacts`);
  });

  it("is held while NoD sending is paused, listed as held, and can be cancelled", async () => {
    await firstSend();
    await tdb.db.update(nodSettings).set({ paused: true }).where(eq(nodSettings.id, 1));
    await tdb.db.transaction((tx) => createCorrectionSends(tx, release.key, request(), RENDER));
    expect((await sendDueJobs({ db: tdb.db, distribution, links: LINKS, render: RENDER })).paused).toBe(true);
    const held = (await getOutgoing(tdb.db)).held.groups;
    expect(held.map((g) => [g.kind, g.emails]).sort()).toEqual([
      ["correction", 3],
      ["correction_media", 3],
    ]);
    const r = await cancelHeldEmail(tdb.db, held.flatMap((g) => g.jobIds), "Avery Admin");
    expect(r).toEqual({ cancelledJobs: 2, cancelledEmails: 6 });
    await tdb.db.update(nodSettings).set({ paused: false }).where(eq(nodSettings.id, 1));
    await sendDueJobs({ db: tdb.db, distribution, links: LINKS, render: RENDER });
    expect(sent).toEqual([]);
  });

  it("nothing for a release that's off the site, or that NoD never had", async () => {
    await firstSend();
    await withdrawItem(tdb.db, release.key);
    expect(await tdb.db.transaction((tx) => createCorrectionSends(tx, release.key, request(), RENDER))).toEqual({ subscribers: 0, mediaContacts: 0 });
    expect(await tdb.db.transaction((tx) => createCorrectionSends(tx, "NEVER-SENT", request(), RENDER))).toEqual({ subscribers: 0, mediaContacts: 0 });
    expect(await correctionAudience(tdb.db, { ...audienceInput, itemKey: "NEVER-SENT" })).toEqual({ subscribers: 0, mediaContacts: 0, both: 0 });
    expect((await tdb.db.select().from(sendJobs).where(eq(sendJobs.kind, "correction"))).length).toBe(0);
  });

  it("media copies only go to the release's current media lists", async () => {
    await firstSend();
    // Media lists turned off in the correction: the item carries none, so nobody gets a media copy.
    await refreshReleaseItem(tdb.db, { ...release, publishFlags: { ...release.publishFlags, toMediaLists: false } }, RENDER.siteUrl);
    expect(await correctionAudience(tdb.db, { ...audienceInput, mediaListKeys: [] })).toEqual({ subscribers: 4, mediaContacts: 0, both: 0 });
    expect(await tdb.db.transaction((tx) => createCorrectionSends(tx, release.key, request(), RENDER))).toEqual({ subscribers: 4, mediaContacts: 0 });
  });
});

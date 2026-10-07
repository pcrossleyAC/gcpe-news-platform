import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import type { TestDatabase } from "@gcpe/db-kit";
import type { DeliveryBounced } from "@gcpe/events";
import { createItemSending } from "./as-it-happens";
import { countBouncedEmails, onDeliveryBounced } from "./bounces";
import { deliveries, items, sendJobs, subscriberHistory, subscribers, subscriptions } from "./db/schema";
import { createNodTestDb, envelope } from "../test/helpers";

let jobSeq = 0;
/** A minimal real send_jobs row -- deliveries.job_id is a real FK, so a test that groups
 * several delivery rows by a shared job (the fallback match's own grouping) needs one to
 * reference. */
async function insertJob(db: TestDatabase["db"]): Promise<string> {
  const [row] = await db.insert(sendJobs).values({ jobKey: `bounces-test-job-${++jobSeq}` }).returning({ id: sendJobs.id });
  return row!.id;
}

const APP_ID = "nod";
const OPTS = { appId: APP_ID };

const daysAgo = (n: number): Date => new Date(Date.now() - n * 24 * 3_600_000);

async function insertSubscriber(db: TestDatabase["db"], email: string, overrides: Partial<typeof subscribers.$inferInsert> = {}) {
  const [row] = await db
    .insert(subscribers)
    .values({ email, status: "active", verifiedAt: new Date(), asItHappens: true, ...overrides })
    .returning();
  return row!;
}

async function insertDelivery(
  db: TestDatabase["db"],
  opts: {
    subscriberId: string;
    itemKey: string;
    mode?: "as_it_happens" | "digest" | "media";
    attemptedAt?: Date | null;
    distributionBatchId?: string | null;
    jobId?: string | null;
    hardBouncedAt?: Date | null;
    bounceStatus?: string | null;
  },
) {
  await db.insert(deliveries).values({
    subscriberId: opts.subscriberId,
    itemKey: opts.itemKey,
    mode: opts.mode ?? "as_it_happens",
    attemptedAt: opts.attemptedAt ?? new Date(),
    distributionBatchId: opts.distributionBatchId ?? null,
    jobId: opts.jobId ?? null,
    hardBouncedAt: opts.hardBouncedAt ?? null,
    bounceStatus: opts.bounceStatus ?? null,
  });
}

/** One "email": `n` digest item rows sharing one batch id (or job id, for the fallback-match
 * tests), the shape send-jobs.ts's sendAllChunks actually produces for a digest send. */
async function insertEmail(
  db: TestDatabase["db"],
  opts: { subscriberId: string; itemKeyPrefix: string; n: number; attemptedAt: Date; distributionBatchId?: string | null; jobId?: string | null; hardBounced?: boolean },
) {
  for (let i = 0; i < opts.n; i++) {
    await insertDelivery(db, {
      subscriberId: opts.subscriberId,
      itemKey: `${opts.itemKeyPrefix}-${i}`,
      mode: "digest",
      attemptedAt: opts.attemptedAt,
      distributionBatchId: opts.distributionBatchId ?? null,
      jobId: opts.jobId ?? null,
      hardBouncedAt: opts.hardBounced ? opts.attemptedAt : null,
      bounceStatus: opts.hardBounced ? "5.1.1" : null,
    });
  }
}

function bounceEvent(data: Partial<DeliveryBounced> & { email: string }) {
  const full: DeliveryBounced = {
    appId: APP_ID,
    batchId: randomUUID(),
    messageId: randomUUID(),
    hard: true,
    status: "5.1.1",
    at: new Date().toISOString(),
    ...data,
  };
  return envelope("distribution", "delivery.bounced", full, `message:${full.messageId}`);
}

async function deliveryFor(db: TestDatabase["db"], subscriberId: string, itemKey: string) {
  return (await db.select().from(deliveries).where(and(eq(deliveries.subscriberId, subscriberId), eq(deliveries.itemKey, itemKey))))[0]!;
}

async function deliveriesFor(db: TestDatabase["db"], subscriberId: string, itemKeyPrefix: string) {
  return db.select().from(deliveries).where(and(eq(deliveries.subscriberId, subscriberId), sql`${deliveries.itemKey} LIKE ${`${itemKeyPrefix}-%`}`));
}

async function historyActions(db: TestDatabase["db"], subscriberId: string) {
  const rows = await db.select().from(subscriberHistory).where(eq(subscriberHistory.subscriberId, subscriberId));
  return rows.map((r) => r.action);
}

describe("onDeliveryBounced", () => {
  let tdb: TestDatabase;

  beforeAll(async () => {
    tdb = await createNodTestDb();
  });
  afterAll(async () => tdb.drop());
  beforeEach(async () => {
    await tdb.pool.query("TRUNCATE TABLE subscriber_history, deliveries, job_recipients, send_jobs, subscriptions, subscribers, items CASCADE");
  });

  it("a hard bounce marks the matched delivery and writes one bounce-recorded history row", async () => {
    const sub = await insertSubscriber(tdb.db, "alex@example.test");
    const batchId = randomUUID();
    await insertDelivery(tdb.db, { subscriberId: sub.id, itemKey: "item-1", distributionBatchId: batchId });

    const result = await tdb.db.transaction((tx) => onDeliveryBounced(tx, bounceEvent({ email: "alex@example.test", batchId, hard: true, status: "5.1.1" }), OPTS));

    expect(result).toEqual({ matched: true, action: "recorded" });
    const delivery = await deliveryFor(tdb.db, sub.id, "item-1");
    expect(delivery.hardBouncedAt).not.toBeNull();
    expect(delivery.bounceStatus).toBe("5.1.1");
    expect(await historyActions(tdb.db, sub.id)).toEqual(["bounce-recorded"]);
    const [history] = await tdb.db.select().from(subscriberHistory).where(eq(subscriberHistory.subscriberId, sub.id));
    expect(history!.detail).toBe("5.1.1");
  });

  // The rule's unit is an email, not a delivery row -- a digest leaves one row per item, all
  // sharing the batch id send-jobs.ts stamped on the whole send.
  it("a digest bounce marks every item row of that batch", async () => {
    const sub = await insertSubscriber(tdb.db, "digest@example.test");
    const batchId = randomUUID();
    await insertEmail(tdb.db, { subscriberId: sub.id, itemKeyPrefix: "digest-item", n: 3, attemptedAt: new Date(), distributionBatchId: batchId });

    const result = await tdb.db.transaction((tx) => onDeliveryBounced(tx, bounceEvent({ email: "digest@example.test", batchId, hard: true, status: "5.1.1" }), OPTS));

    expect(result).toEqual({ matched: true, action: "recorded" });
    const rows = await deliveriesFor(tdb.db, sub.id, "digest-item");
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row.hardBouncedAt).not.toBeNull();
      expect(row.bounceStatus).toBe("5.1.1");
    }
    expect(await historyActions(tdb.db, sub.id)).toEqual(["bounce-recorded"]); // one row, not three
  });

  it("a replayed digest bounce is still one history row, and doesn't re-mark anything", async () => {
    const sub = await insertSubscriber(tdb.db, "digest-replay@example.test");
    const batchId = randomUUID();
    await insertEmail(tdb.db, { subscriberId: sub.id, itemKeyPrefix: "digest-replay-item", n: 3, attemptedAt: new Date(), distributionBatchId: batchId });
    const event = bounceEvent({ email: "digest-replay@example.test", batchId, hard: true });

    const first = await tdb.db.transaction((tx) => onDeliveryBounced(tx, event, OPTS));
    const second = await tdb.db.transaction((tx) => onDeliveryBounced(tx, event, OPTS));

    expect(first).toEqual({ matched: true, action: "recorded" });
    expect(second).toEqual({ matched: true, action: "none" });
    expect(await historyActions(tdb.db, sub.id)).toEqual(["bounce-recorded"]);
  });

  it("10 digest emails of 3 items each, all bounced: disabled, with one bounce-disabled history row", async () => {
    const sub = await insertSubscriber(tdb.db, "digest-ten@example.test");
    await tdb.db.insert(subscriptions).values({ subscriberId: sub.id, listKey: "*" });
    for (let i = 1; i <= 9; i++) {
      await insertEmail(tdb.db, { subscriberId: sub.id, itemKeyPrefix: `digest-ten-${i}`, n: 3, attemptedAt: daysAgo(i), distributionBatchId: randomUUID(), hardBounced: true });
    }
    const batchId = randomUUID();
    await insertEmail(tdb.db, { subscriberId: sub.id, itemKeyPrefix: "digest-ten-10", n: 3, attemptedAt: daysAgo(10), distributionBatchId: batchId });

    const result = await tdb.db.transaction((tx) => onDeliveryBounced(tx, bounceEvent({ email: "digest-ten@example.test", batchId, hard: true }), OPTS));

    expect(result).toEqual({ matched: true, action: "disabled" });
    const rows = await deliveriesFor(tdb.db, sub.id, "digest-ten-10");
    expect(rows.every((r) => r.hardBouncedAt !== null)).toBe(true);
    const [after] = await tdb.db.select().from(subscribers).where(eq(subscribers.id, sub.id));
    expect(after!.status).toBe("disabled");
    expect(await historyActions(tdb.db, sub.id)).toEqual(["bounce-disabled"]);
  });

  it("9 bounced digest emails and 1 un-bounced 3-row email among the 10 most recent: no action", async () => {
    const sub = await insertSubscriber(tdb.db, "digest-nine@example.test");
    for (let i = 1; i <= 8; i++) {
      await insertEmail(tdb.db, { subscriberId: sub.id, itemKeyPrefix: `digest-nine-${i}`, n: 3, attemptedAt: daysAgo(i), distributionBatchId: randomUUID(), hardBounced: true });
    }
    // The 9th most recent email: attempted, never bounced -- stays that way.
    await insertEmail(tdb.db, { subscriberId: sub.id, itemKeyPrefix: "digest-nine-healthy", n: 3, attemptedAt: daysAgo(9), distributionBatchId: randomUUID() });
    // The 10th most recent email: this event bounces it, bringing the count to 9 bounced of 10.
    const batchId = randomUUID();
    await insertEmail(tdb.db, { subscriberId: sub.id, itemKeyPrefix: "digest-nine-10", n: 3, attemptedAt: daysAgo(10), distributionBatchId: batchId });

    const result = await tdb.db.transaction((tx) => onDeliveryBounced(tx, bounceEvent({ email: "digest-nine@example.test", batchId, hard: true }), OPTS));

    expect(result).toEqual({ matched: true, action: "recorded" });
    const [after] = await tdb.db.select().from(subscribers).where(eq(subscribers.id, sub.id));
    expect(after!.status).toBe("active");
    expect(await historyActions(tdb.db, sub.id)).toEqual(["bounce-recorded"]);
  });

  it("the fallback marks all rows of the latest job, leaving an older job's rows untouched", async () => {
    const sub = await insertSubscriber(tdb.db, "fallback-job@example.test");
    const olderJob = await insertJob(tdb.db);
    await insertEmail(tdb.db, { subscriberId: sub.id, itemKeyPrefix: "fallback-job-older", n: 2, attemptedAt: daysAgo(3), jobId: olderJob });
    const newerJob = await insertJob(tdb.db);
    await insertEmail(tdb.db, { subscriberId: sub.id, itemKeyPrefix: "fallback-job-newer", n: 3, attemptedAt: daysAgo(1), jobId: newerJob });

    const result = await tdb.db.transaction((tx) => onDeliveryBounced(tx, bounceEvent({ email: "fallback-job@example.test", batchId: randomUUID(), hard: true }), OPTS));

    expect(result).toEqual({ matched: true, action: "recorded" });
    const newerRows = await deliveriesFor(tdb.db, sub.id, "fallback-job-newer");
    expect(newerRows).toHaveLength(3);
    expect(newerRows.every((r) => r.hardBouncedAt !== null)).toBe(true);
    const olderRows = await deliveriesFor(tdb.db, sub.id, "fallback-job-older");
    expect(olderRows.every((r) => r.hardBouncedAt === null)).toBe(true);
  });

  // A media-list member can also be a plain public subscriber -- flagging must leave both
  // kinds of lists untouched and the status unchanged.
  it("a media member who also has a public subscription is flagged, stays active, and keeps both lists", async () => {
    const sub = await insertSubscriber(tdb.db, "journo-public@example.test");
    await tdb.db.insert(subscriptions).values([
      { subscriberId: sub.id, listKey: "media-distribution-lists:budget" },
      { subscriberId: sub.id, listKey: "ministries:health" },
    ]);
    for (let i = 1; i <= 9; i++) {
      await insertDelivery(tdb.db, { subscriberId: sub.id, itemKey: `journo-public-${i}`, attemptedAt: daysAgo(i), hardBouncedAt: daysAgo(i), bounceStatus: "5.1.1" });
    }
    const batchId = randomUUID();
    await insertDelivery(tdb.db, { subscriberId: sub.id, itemKey: "journo-public-10", attemptedAt: daysAgo(10), distributionBatchId: batchId });

    const result = await tdb.db.transaction((tx) => onDeliveryBounced(tx, bounceEvent({ email: "journo-public@example.test", batchId, hard: true }), OPTS));

    expect(result).toEqual({ matched: true, action: "flagged" });
    const [after] = await tdb.db.select().from(subscribers).where(eq(subscribers.id, sub.id));
    expect(after).toMatchObject({ status: "active", needsAttention: "bouncing" });
    const subs = await tdb.db.select().from(subscriptions).where(eq(subscriptions.subscriberId, sub.id));
    expect(subs.map((r) => r.listKey).sort()).toEqual(["media-distribution-lists:budget", "ministries:health"]);
  });

  // Flagging must never clobber a reason a media member already needs staff attention for
  // (here, a Media Hub sync collision) -- the bounce threshold is not the only thing that
  // sets needs_attention.
  it("a media member already flagged for another reason keeps that reason and gets no bounce-flagged row", async () => {
    const flaggedAt = daysAgo(30);
    const sub = await insertSubscriber(tdb.db, "journo-already-flagged@example.test", { needsAttention: "email-gone", attentionAt: flaggedAt });
    await tdb.db.insert(subscriptions).values({ subscriberId: sub.id, listKey: "media-distribution-lists:budget" });
    for (let i = 1; i <= 9; i++) {
      await insertDelivery(tdb.db, { subscriberId: sub.id, itemKey: `journo-flagged-${i}`, attemptedAt: daysAgo(i), hardBouncedAt: daysAgo(i), bounceStatus: "5.1.1" });
    }
    const batchId = randomUUID();
    await insertDelivery(tdb.db, { subscriberId: sub.id, itemKey: "journo-flagged-10", attemptedAt: daysAgo(10), distributionBatchId: batchId });

    const result = await tdb.db.transaction((tx) => onDeliveryBounced(tx, bounceEvent({ email: "journo-already-flagged@example.test", batchId, hard: true }), OPTS));

    expect(result).toEqual({ matched: true, action: "recorded" });
    const [after] = await tdb.db.select().from(subscribers).where(eq(subscribers.id, sub.id));
    expect(after!.needsAttention).toBe("email-gone"); // not overwritten to "bouncing"
    expect(after!.attentionAt!.getTime()).toBe(flaggedAt.getTime()); // not touched
    // Staff still see the bounce happened, even though it flagged nothing new.
    expect(await historyActions(tdb.db, sub.id)).toEqual(["bounce-recorded"]);
  });

  // A media member who keeps being sent to (and keeps bouncing) re-trips the threshold on
  // every later hard bounce -- once already flagged "bouncing", that must write no second
  // history row and must not reset attention_at.
  it("a media member who re-trips the threshold after already being flagged gets no second bounce-flagged row", async () => {
    const sub = await insertSubscriber(tdb.db, "journo-rebounce@example.test");
    await tdb.db.insert(subscriptions).values({ subscriberId: sub.id, listKey: "media-distribution-lists:budget" });
    for (let i = 1; i <= 9; i++) {
      await insertDelivery(tdb.db, { subscriberId: sub.id, itemKey: `journo-rebounce-${i}`, attemptedAt: daysAgo(i), hardBouncedAt: daysAgo(i), bounceStatus: "5.1.1" });
    }
    const firstBatchId = randomUUID();
    await insertDelivery(tdb.db, { subscriberId: sub.id, itemKey: "journo-rebounce-10", attemptedAt: daysAgo(10), distributionBatchId: firstBatchId });
    const firstResult = await tdb.db.transaction((tx) => onDeliveryBounced(tx, bounceEvent({ email: "journo-rebounce@example.test", batchId: firstBatchId, hard: true }), OPTS));
    expect(firstResult).toEqual({ matched: true, action: "flagged" });
    const [firstFlagged] = await tdb.db.select().from(subscribers).where(eq(subscribers.id, sub.id));
    const firstAttentionAt = firstFlagged!.attentionAt!;

    // An 11th email, more recent still, also bounces hard -- the 10 most recent are now
    // emails 2-11, still all hard-bounced, so the threshold trips again.
    const secondBatchId = randomUUID();
    await insertDelivery(tdb.db, { subscriberId: sub.id, itemKey: "journo-rebounce-11", attemptedAt: new Date(), distributionBatchId: secondBatchId });
    const secondResult = await tdb.db.transaction((tx) => onDeliveryBounced(tx, bounceEvent({ email: "journo-rebounce@example.test", batchId: secondBatchId, hard: true }), OPTS));

    expect(secondResult).toEqual({ matched: true, action: "flagged" });
    const [after] = await tdb.db.select().from(subscribers).where(eq(subscribers.id, sub.id));
    expect(after!.needsAttention).toBe("bouncing");
    expect(after!.attentionAt!.getTime()).toBe(firstAttentionAt.getTime()); // not reset
    expect(await historyActions(tdb.db, sub.id)).toEqual(["bounce-flagged"]); // still just one
  });

  it("the same hard-bounce event processed twice writes only one history row", async () => {
    const sub = await insertSubscriber(tdb.db, "dup@example.test");
    const batchId = randomUUID();
    await insertDelivery(tdb.db, { subscriberId: sub.id, itemKey: "item-dup", distributionBatchId: batchId });
    const event = bounceEvent({ email: "dup@example.test", batchId, hard: true });

    const first = await tdb.db.transaction((tx) => onDeliveryBounced(tx, event, OPTS));
    const second = await tdb.db.transaction((tx) => onDeliveryBounced(tx, event, OPTS));

    expect(first).toEqual({ matched: true, action: "recorded" });
    expect(second).toEqual({ matched: true, action: "none" });
    expect(await historyActions(tdb.db, sub.id)).toEqual(["bounce-recorded"]);
  });

  it("9 hard of the 10 most recent deliveries within 15 days: no action", async () => {
    const sub = await insertSubscriber(tdb.db, "nine@example.test");
    for (let i = 1; i <= 8; i++) {
      await insertDelivery(tdb.db, { subscriberId: sub.id, itemKey: `item-${i}`, attemptedAt: daysAgo(i), hardBouncedAt: daysAgo(i), bounceStatus: "5.1.1" });
    }
    // The 9th most recent: attempted, never bounced -- stays that way.
    await insertDelivery(tdb.db, { subscriberId: sub.id, itemKey: "item-healthy", attemptedAt: daysAgo(9) });
    // The 10th most recent: this event hard-bounces it, bringing the hard count to 9 of 10.
    const batchId = randomUUID();
    await insertDelivery(tdb.db, { subscriberId: sub.id, itemKey: "item-10", attemptedAt: daysAgo(10), distributionBatchId: batchId });

    const result = await tdb.db.transaction((tx) => onDeliveryBounced(tx, bounceEvent({ email: "nine@example.test", batchId, hard: true }), OPTS));

    expect(result).toEqual({ matched: true, action: "recorded" });
    const [after] = await tdb.db.select().from(subscribers).where(eq(subscribers.id, sub.id));
    expect(after!.status).toBe("active");
    expect(await historyActions(tdb.db, sub.id)).toEqual(["bounce-recorded"]);
  });

  it("10 of 10 most recent deliveries within 15 days, all hard: disabled, with history detail 10/15d, and excluded from the next As-It-Happens job", async () => {
    const sub = await insertSubscriber(tdb.db, "ten@example.test");
    await tdb.db.insert(subscriptions).values({ subscriberId: sub.id, listKey: "*" });
    for (let i = 1; i <= 9; i++) {
      await insertDelivery(tdb.db, { subscriberId: sub.id, itemKey: `item-${i}`, attemptedAt: daysAgo(i), hardBouncedAt: daysAgo(i), bounceStatus: "5.1.1" });
    }
    const batchId = randomUUID();
    await insertDelivery(tdb.db, { subscriberId: sub.id, itemKey: "item-10", attemptedAt: daysAgo(10), distributionBatchId: batchId });

    const result = await tdb.db.transaction((tx) => onDeliveryBounced(tx, bounceEvent({ email: "ten@example.test", batchId, hard: true }), OPTS));

    expect(result).toEqual({ matched: true, action: "disabled" });
    const [after] = await tdb.db.select().from(subscribers).where(eq(subscribers.id, sub.id));
    expect(after!.status).toBe("disabled");
    expect(await historyActions(tdb.db, sub.id)).toEqual(["bounce-disabled"]);
    const [history] = await tdb.db.select().from(subscriberHistory).where(eq(subscriberHistory.subscriberId, sub.id));
    expect(history!.detail).toBe("10/15d");

    // Review focus / disabled semantics: the next As-It-Happens job must exclude them.
    const { createItemSend } = createItemSending({ render: { siteUrl: "https://news.example/site", bannerUrl: null } });
    await tdb.db.insert(items).values({
      key: "item-after-disable",
      kind: "release",
      listKeys: ["ministries:health"],
      title: "After disable",
      url: "https://news.example/site/releases/item-after-disable",
      publishedAt: new Date(),
    });
    const created = await tdb.db.transaction((tx) => createItemSend(tx, "item-after-disable", "as_it_happens"));
    expect(created).toBe(false); // the only matching subscriber is now disabled -- nobody to send to
    const [job] = await tdb.db.select().from(sendJobs).where(eq(sendJobs.jobKey, "as_it_happens:item-after-disable"));
    expect(job).toBeUndefined();
  });

  it("10 hard bounces but one older than 15 days: no action", async () => {
    const sub = await insertSubscriber(tdb.db, "stale@example.test");
    for (let i = 1; i <= 9; i++) {
      await insertDelivery(tdb.db, { subscriberId: sub.id, itemKey: `item-${i}`, attemptedAt: daysAgo(i), hardBouncedAt: daysAgo(i), bounceStatus: "5.1.1" });
    }
    // This one is hard-bounced by the event below, but its attempted_at is outside the 15-day
    // window, so it never counts toward the 10 most recent within it.
    const batchId = randomUUID();
    await insertDelivery(tdb.db, { subscriberId: sub.id, itemKey: "item-stale", attemptedAt: daysAgo(16), distributionBatchId: batchId });

    const result = await tdb.db.transaction((tx) => onDeliveryBounced(tx, bounceEvent({ email: "stale@example.test", batchId, hard: true }), OPTS));

    expect(result).toEqual({ matched: true, action: "recorded" });
    const [after] = await tdb.db.select().from(subscribers).where(eq(subscribers.id, sub.id));
    expect(after!.status).toBe("active");
  });

  it("a media-list member who trips the threshold is flagged 'bouncing', not disabled, and keeps their lists", async () => {
    const sub = await insertSubscriber(tdb.db, "journo@example.test");
    await tdb.db.insert(subscriptions).values({ subscriberId: sub.id, listKey: "media-distribution-lists:budget" });
    for (let i = 1; i <= 9; i++) {
      await insertDelivery(tdb.db, { subscriberId: sub.id, itemKey: `item-${i}`, mode: "media", attemptedAt: daysAgo(i), hardBouncedAt: daysAgo(i), bounceStatus: "5.1.1" });
    }
    const batchId = randomUUID();
    await insertDelivery(tdb.db, { subscriberId: sub.id, itemKey: "item-10", mode: "media", attemptedAt: daysAgo(10), distributionBatchId: batchId });

    const result = await tdb.db.transaction((tx) => onDeliveryBounced(tx, bounceEvent({ email: "journo@example.test", batchId, hard: true }), OPTS));

    expect(result).toEqual({ matched: true, action: "flagged" });
    const [after] = await tdb.db.select().from(subscribers).where(eq(subscribers.id, sub.id));
    expect(after).toMatchObject({ status: "active", needsAttention: "bouncing" });
    expect(after!.attentionAt).not.toBeNull();
    expect(await historyActions(tdb.db, sub.id)).toEqual(["bounce-flagged"]);
    const subs = await tdb.db.select().from(subscriptions).where(eq(subscriptions.subscriberId, sub.id));
    expect(subs.map((r) => r.listKey)).toContain("media-distribution-lists:budget");
  });

  it("soft bounces are recorded but never count toward the threshold", async () => {
    const sub = await insertSubscriber(tdb.db, "soft@example.test");
    for (let i = 1; i <= 9; i++) {
      await insertDelivery(tdb.db, { subscriberId: sub.id, itemKey: `item-${i}`, attemptedAt: daysAgo(i), hardBouncedAt: daysAgo(i), bounceStatus: "5.1.1" });
    }
    const batchId = randomUUID();
    await insertDelivery(tdb.db, { subscriberId: sub.id, itemKey: "item-soft", attemptedAt: daysAgo(10), distributionBatchId: batchId });

    const result = await tdb.db.transaction((tx) => onDeliveryBounced(tx, bounceEvent({ email: "soft@example.test", batchId, hard: false, status: "4.4.7" }), OPTS));

    expect(result).toEqual({ matched: true, action: "none" });
    const delivery = await deliveryFor(tdb.db, sub.id, "item-soft");
    expect(delivery.hardBouncedAt).toBeNull();
    expect(delivery.bounceStatus).toBe("4.4.7");
    const [after] = await tdb.db.select().from(subscribers).where(eq(subscribers.id, sub.id));
    expect(after!.status).toBe("active");
    expect(await historyActions(tdb.db, sub.id)).toEqual([]);
  });

  it("an event for another app is ignored", async () => {
    const sub = await insertSubscriber(tdb.db, "other-app@example.test");
    const batchId = randomUUID();
    await insertDelivery(tdb.db, { subscriberId: sub.id, itemKey: "item-other-app", distributionBatchId: batchId });

    const result = await tdb.db.transaction((tx) => onDeliveryBounced(tx, bounceEvent({ email: "other-app@example.test", appId: "some-other-app", batchId, hard: true }), OPTS));

    expect(result).toEqual({ matched: false, action: "none" });
    const delivery = await deliveryFor(tdb.db, sub.id, "item-other-app");
    expect(delivery.hardBouncedAt).toBeNull();
  });

  it("falls back to the subscriber's most recent attempted delivery when no delivery carries the event's batch id", async () => {
    const sub = await insertSubscriber(tdb.db, "fallback@example.test");
    await insertDelivery(tdb.db, { subscriberId: sub.id, itemKey: "item-fallback-older", attemptedAt: daysAgo(2) });
    await insertDelivery(tdb.db, { subscriberId: sub.id, itemKey: "item-fallback-newer", attemptedAt: daysAgo(1) });

    const result = await tdb.db.transaction((tx) => onDeliveryBounced(tx, bounceEvent({ email: "fallback@example.test", batchId: randomUUID(), hard: true }), OPTS));

    expect(result).toEqual({ matched: true, action: "recorded" });
    expect((await deliveryFor(tdb.db, sub.id, "item-fallback-newer")).hardBouncedAt).not.toBeNull();
    expect((await deliveryFor(tdb.db, sub.id, "item-fallback-older")).hardBouncedAt).toBeNull();
  });

  // A verification/manage-link email creates no deliveries row at all, but its own
  // (Distribution-real, just NoD-untracked) batchId can land near a genuine release send for
  // the same subscriber. The candidate the recency fallback would otherwise pick already
  // belongs to a *different*, confirmed batch of its own -- attributing this event to it would
  // misattribute the bounce, so nothing is recorded instead.
  it("does not fall back to a delivery that already belongs to a different, confirmed batch", async () => {
    const sub = await insertSubscriber(tdb.db, "fallback-foreign-batch@example.test");
    await insertDelivery(tdb.db, { subscriberId: sub.id, itemKey: "item-real-send", attemptedAt: daysAgo(1), distributionBatchId: randomUUID() });

    const result = await tdb.db.transaction((tx) => onDeliveryBounced(tx, bounceEvent({ email: "fallback-foreign-batch@example.test", batchId: randomUUID(), hard: true }), OPTS));

    expect(result).toEqual({ matched: false, action: "none" });
    expect((await deliveryFor(tdb.db, sub.id, "item-real-send")).hardBouncedAt).toBeNull();
    expect(await historyActions(tdb.db, sub.id)).toEqual([]);
  });

  it("no subscriber for the address: unmatched", async () => {
    const result = await tdb.db.transaction((tx) => onDeliveryBounced(tx, bounceEvent({ email: "nobody@example.test", batchId: randomUUID(), hard: true }), OPTS));
    expect(result).toEqual({ matched: false, action: "none" });
  });

  it("no delivery at all for the subscriber: unmatched", async () => {
    await insertSubscriber(tdb.db, "no-delivery@example.test");
    const result = await tdb.db.transaction((tx) => onDeliveryBounced(tx, bounceEvent({ email: "no-delivery@example.test", batchId: randomUUID(), hard: true }), OPTS));
    expect(result).toEqual({ matched: false, action: "none" });
  });
});

describe("countBouncedEmails", () => {
  let tdb: TestDatabase;

  beforeAll(async () => {
    tdb = await createNodTestDb();
  });
  afterAll(async () => tdb.drop());
  beforeEach(async () => {
    await tdb.pool.query("TRUNCATE TABLE subscriber_history, deliveries, job_recipients, send_jobs, subscriptions, subscribers, items CASCADE");
  });

  it("counts emails (not delivery rows), only the hard-bounced ones, within the 15-day window", async () => {
    const sub = await insertSubscriber(tdb.db, "count@example.test");
    // A 3-item digest email, hard-bounced -- one email, not three.
    await insertEmail(tdb.db, { subscriberId: sub.id, itemKeyPrefix: "digest", n: 3, attemptedAt: daysAgo(1), distributionBatchId: randomUUID(), hardBounced: true });
    // A single as-it-happens email, also hard-bounced.
    await insertDelivery(tdb.db, { subscriberId: sub.id, itemKey: "aih-1", attemptedAt: daysAgo(2), hardBouncedAt: daysAgo(2), bounceStatus: "5.1.1" });
    // A soft bounce: recorded, but never counted.
    await insertDelivery(tdb.db, { subscriberId: sub.id, itemKey: "aih-2", attemptedAt: daysAgo(3), bounceStatus: "4.4.7" });
    // Outside the 15-day window entirely.
    await insertDelivery(tdb.db, { subscriberId: sub.id, itemKey: "aih-old", attemptedAt: daysAgo(20), hardBouncedAt: daysAgo(20), bounceStatus: "5.1.1" });

    const count = await tdb.db.transaction((tx) => countBouncedEmails(tx, sub.id));
    expect(count).toBe(2);
  });

  it("zero for a subscriber with no deliveries at all", async () => {
    const sub = await insertSubscriber(tdb.db, "nobody-bounced@example.test");
    const count = await tdb.db.transaction((tx) => countBouncedEmails(tx, sub.id));
    expect(count).toBe(0);
  });
});

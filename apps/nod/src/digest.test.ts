import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import type { TestDatabase } from "@gcpe/db-kit";
import { createNodTestDb } from "../test/helpers";
import { createItemSending } from "./as-it-happens";
import type { DistributionClient } from "./distribution-client";
import { deliveries, items, jobRecipients, nodSettings, sendJobs, subscribers } from "./db/schema";
import { DIGEST_HOUR, digestCutoff, runDigestIfDue } from "./digest";
import type { RecipientLinkOptions } from "./recipient-links";
import { sendDueJobs } from "./send-jobs";
import { addSubscriber } from "./subscribers";
import type { RenderOptions } from "./render";

const PUBLIC_SITE_URL = "https://news.example/site";
const RENDER: RenderOptions = { siteUrl: PUBLIC_SITE_URL, bannerUrl: null };
const LINKS: RecipientLinkOptions = {
  pageUrl: "https://news.example/subscribe/manage",
  subscribeApiUrl: "https://news.example/api/Subscribe",
  linkSecret: "test-link-secret-at-least-32-chars-long",
};
const TZ = "America/Vancouver";
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

describe("digestCutoff", () => {
  const tz = TZ;

  it("DIGEST_HOUR is 17:00", () => {
    expect(DIGEST_HOUR).toBe(17);
  });

  it("is today 17:00 local once past it, yesterday's before", () => {
    expect(digestCutoff(new Date("2026-10-06T00:30:00Z"), tz).toISOString()).toBe("2026-10-06T00:00:00.000Z"); // 17:30 PDT -> 17:00 PDT
    expect(digestCutoff(new Date("2026-10-05T23:59:00Z"), tz).toISOString()).toBe("2026-10-05T00:00:00.000Z"); // 16:59 PDT -> yesterday 17:00
  });

  it("cutoff across zone changes", () => {
    // BC permanent UTC-7 from 2026-11-01 (tzdata 2026b+): 17:00 local = 00:00Z next day, both sides.
    expect(digestCutoff(new Date("2026-11-03T01:00:00Z"), tz).toISOString()).toBe("2026-11-03T00:00:00.000Z");
    // Spring forward 2026-03-08 (UTC-8 -> UTC-7): 17:00 still exists.
    expect(digestCutoff(new Date("2026-03-09T01:00:00Z"), tz).toISOString()).toBe("2026-03-09T00:00:00.000Z");
    // Before it, in standard time (UTC-8): 17:00 = 01:00Z.
    expect(digestCutoff(new Date("2026-02-10T02:00:00Z"), tz).toISOString()).toBe("2026-02-10T01:00:00.000Z");
  });
});

function itemKey(prefix: string): string {
  return `${prefix}-${randomUUID().slice(0, 8)}`;
}

async function insertItem(db: TestDatabase["db"], overrides: Partial<typeof items.$inferInsert> & { key: string }): Promise<void> {
  await db.insert(items).values({
    kind: "release",
    postKind: "releases",
    listKeys: ["ministries:health"],
    title: `Title ${overrides.key}`,
    summary: "Summary",
    url: `${PUBLIC_SITE_URL}/releases/${overrides.key}`,
    publishedAt: new Date(),
    toSubscribers: true,
    ...overrides,
  });
}

/** A subscriber opted into the digest (and, by default, not As-It-Happens -- addSubscriber's
 * own default is the other way around, so this flips both explicitly). */
async function digestSubscriber(db: TestDatabase["db"], email: string, lists: string[] | "all", asItHappens = false): Promise<string> {
  const { id } = await addSubscriber(db, { email, lists });
  await db.update(subscribers).set({ digest: true, asItHappens }).where(eq(subscribers.id, id));
  return id;
}

describe("runDigestIfDue", () => {
  let tdb: TestDatabase;
  let cutoff: Date;

  beforeAll(async () => {
    tdb = await createNodTestDb();
  });
  afterAll(async () => {
    await tdb.drop();
  });
  beforeEach(async () => {
    await tdb.pool.query("TRUNCATE deliveries, send_jobs, job_recipients, items, digest_runs, subscriptions, subscribers CASCADE");
    await tdb.db.update(nodSettings).set({ lastDigestCutoff: null, paused: false }).where(eq(nodSettings.id, 1));
    // The real clock is fine here (per the brief): only relative order to `cutoff` matters,
    // never its exact value.
    cutoff = digestCutoff(new Date(), TZ);
  });

  async function setLastCutoff(d: Date | null): Promise<void> {
    await tdb.db.update(nodSettings).set({ lastDigestCutoff: d }).where(eq(nodSettings.id, 1));
  }

  it("groups subscribers by matching items: same lists share one job, different lists get separate jobs, job_recipients mirrors each job's group, and deliveries has one digest row per item per subscriber", async () => {
    await setLastCutoff(new Date(cutoff.getTime() - DAY_MS));
    const health1 = await digestSubscriber(tdb.db, "h1@example.com", ["ministries:health"]);
    const health2 = await digestSubscriber(tdb.db, "h2@example.com", ["ministries:health"]);
    const mining = await digestSubscriber(tdb.db, "m1@example.com", ["sectors:mining"]);

    const kHealth = itemKey("HEALTH");
    const kMining = itemKey("MINING");
    await insertItem(tdb.db, { key: kHealth, listKeys: ["ministries:health"], publishedAt: new Date(cutoff.getTime() - HOUR_MS) });
    await insertItem(tdb.db, { key: kMining, listKeys: ["sectors:mining"], publishedAt: new Date(cutoff.getTime() - HOUR_MS) });

    const result = await runDigestIfDue(tdb.db, TZ, RENDER);
    expect(result.ran).toBe(true);
    expect(result.groups).toBe(2);
    expect(result.subscribers).toBe(3);

    const jobs = await tdb.db.select().from(sendJobs).where(eq(sendJobs.kind, "digest"));
    expect(jobs).toHaveLength(2);

    const recipientsByJob = new Map<string, string[]>();
    for (const job of jobs) {
      const recs = await tdb.db.select({ subscriberId: jobRecipients.subscriberId }).from(jobRecipients).where(eq(jobRecipients.jobId, job.id));
      recipientsByJob.set(job.id, recs.map((r) => r.subscriberId).sort());
    }
    const groupsFound = [...recipientsByJob.values()].map((g) => g.sort().join(","));
    expect(new Set(groupsFound)).toEqual(new Set([[health1, health2].sort().join(","), [mining].join(",")]));

    const deliveryRows = await tdb.db.select().from(deliveries).where(eq(deliveries.mode, "digest"));
    expect(deliveryRows).toHaveLength(3); // health1+health2 x kHealth, mining x kMining
    expect(deliveryRows.filter((d) => d.itemKey === kHealth).map((d) => d.subscriberId).sort()).toEqual([health1, health2].sort());
    expect(deliveryRows.filter((d) => d.itemKey === kMining).map((d) => d.subscriberId)).toEqual([mining]);
  });

  it("excludes advisories, items with toSubscribers=false, emergency items, items outside the window, and withdrawn items", async () => {
    await setLastCutoff(new Date(cutoff.getTime() - DAY_MS));
    const sub = await digestSubscriber(tdb.db, "excl@example.com", ["ministries:health"]);

    const kOk = itemKey("OK");
    await insertItem(tdb.db, { key: kOk, listKeys: ["ministries:health"], publishedAt: new Date(cutoff.getTime() - HOUR_MS) });
    await insertItem(tdb.db, {
      key: itemKey("ADV"),
      postKind: "advisories",
      listKeys: ["ministries:health"],
      publishedAt: new Date(cutoff.getTime() - HOUR_MS),
    });
    await insertItem(tdb.db, {
      key: itemKey("NOSUB"),
      listKeys: ["ministries:health"],
      toSubscribers: false,
      publishedAt: new Date(cutoff.getTime() - HOUR_MS),
    });
    await insertItem(tdb.db, { key: itemKey("FUT"), listKeys: ["ministries:health"], publishedAt: new Date(cutoff.getTime() + HOUR_MS) });
    await insertItem(tdb.db, {
      key: itemKey("PAST"),
      listKeys: ["ministries:health"],
      publishedAt: new Date(cutoff.getTime() - DAY_MS - HOUR_MS),
    });
    await insertItem(tdb.db, {
      key: itemKey("WD"),
      listKeys: ["ministries:health"],
      publishedAt: new Date(cutoff.getTime() - HOUR_MS),
      withdrawnAt: new Date(),
    });
    await tdb.db.insert(items).values({
      key: `emergency:${itemKey("EMG")}`,
      kind: "emergency",
      listKeys: ["ministries:health"],
      title: "Evacuation order",
      summary: "Leave the area immediately.",
      url: `${PUBLIC_SITE_URL}/emergency/1`,
      publishedAt: new Date(cutoff.getTime() - HOUR_MS),
      toSubscribers: true,
    });

    const result = await runDigestIfDue(tdb.db, TZ, RENDER);
    expect(result.ran).toBe(true);
    expect(result.groups).toBe(1);

    const deliveredKeys = (await tdb.db.select({ itemKey: deliveries.itemKey }).from(deliveries).where(eq(deliveries.subscriberId, sub))).map(
      (d) => d.itemKey,
    );
    expect(deliveredKeys).toEqual([kOk]);
  });

  it("As-It-Happens-only subscribers (digest=false) get nothing", async () => {
    await setLastCutoff(new Date(cutoff.getTime() - DAY_MS));
    const { id: aihOnly } = await addSubscriber(tdb.db, { email: "aih@example.com", lists: ["ministries:health"] }); // digest stays false
    await insertItem(tdb.db, { key: itemKey("AIH"), listKeys: ["ministries:health"], publishedAt: new Date(cutoff.getTime() - HOUR_MS) });

    const result = await runDigestIfDue(tdb.db, TZ, RENDER);
    expect(result.ran).toBe(true);
    expect(result.groups).toBe(0);
    expect(result.subscribers).toBe(0);
    expect(await tdb.db.select().from(deliveries).where(eq(deliveries.subscriberId, aihOnly))).toHaveLength(0);
  });

  it("a second run of the same cutoff returns ran:false and creates nothing", async () => {
    await setLastCutoff(new Date(cutoff.getTime() - DAY_MS));
    await digestSubscriber(tdb.db, "s@example.com", ["ministries:health"]);
    await insertItem(tdb.db, { key: itemKey("SECOND"), listKeys: ["ministries:health"], publishedAt: new Date(cutoff.getTime() - HOUR_MS) });

    const first = await runDigestIfDue(tdb.db, TZ, RENDER);
    expect(first.ran).toBe(true);
    const jobsAfterFirst = await tdb.db.select().from(sendJobs);
    const deliveriesAfterFirst = await tdb.db.select().from(deliveries);

    const second = await runDigestIfDue(tdb.db, TZ, RENDER);
    expect(second).toEqual({ ran: false, cutoff: first.cutoff, subscribers: 0, groups: 0 });

    expect(await tdb.db.select().from(sendJobs)).toHaveLength(jobsAfterFirst.length);
    expect(await tdb.db.select().from(deliveries)).toHaveLength(deliveriesAfterFirst.length);
  });

  it("catch-up: a stale last_digest_cutoff pulls in every item since, in one digest", async () => {
    await setLastCutoff(new Date(cutoff.getTime() - 3 * DAY_MS));
    const sub = await digestSubscriber(tdb.db, "catchup@example.com", ["ministries:health"]);
    const k1 = itemKey("D1");
    const k2 = itemKey("D2");
    const k3 = itemKey("D3");
    await insertItem(tdb.db, { key: k1, listKeys: ["ministries:health"], publishedAt: new Date(cutoff.getTime() - 2.5 * DAY_MS) });
    await insertItem(tdb.db, { key: k2, listKeys: ["ministries:health"], publishedAt: new Date(cutoff.getTime() - 1.5 * DAY_MS) });
    await insertItem(tdb.db, { key: k3, listKeys: ["ministries:health"], publishedAt: new Date(cutoff.getTime() - 0.5 * DAY_MS) });

    const result = await runDigestIfDue(tdb.db, TZ, RENDER);
    expect(result.ran).toBe(true);
    expect(result.groups).toBe(1);

    const deliveredKeys = (await tdb.db.select({ itemKey: deliveries.itemKey }).from(deliveries).where(eq(deliveries.subscriberId, sub)))
      .map((d) => d.itemKey)
      .sort();
    expect(deliveredKeys).toEqual([k1, k2, k3].sort());
  });

  it("concurrent runs send exactly one digest", async () => {
    await setLastCutoff(new Date(cutoff.getTime() - DAY_MS));
    await digestSubscriber(tdb.db, "concurrent@example.com", ["ministries:health"]);
    await insertItem(tdb.db, { key: itemKey("CONC"), listKeys: ["ministries:health"], publishedAt: new Date(cutoff.getTime() - HOUR_MS) });

    const [a, b] = await Promise.all([runDigestIfDue(tdb.db, TZ, RENDER), runDigestIfDue(tdb.db, TZ, RENDER)]);
    expect([a.ran, b.ran].filter(Boolean)).toHaveLength(1);

    expect(await tdb.db.select().from(sendJobs).where(eq(sendJobs.kind, "digest"))).toHaveLength(1);
  });

  it("first run ever (last_digest_cutoff null): the window is the 24h before cutoff", async () => {
    // lastDigestCutoff is already null from beforeEach.
    const sub = await digestSubscriber(tdb.db, "first@example.com", ["ministries:health"]);
    const kInWindow = itemKey("INWIN");
    const kTooOld = itemKey("OLD");
    await insertItem(tdb.db, { key: kInWindow, listKeys: ["ministries:health"], publishedAt: new Date(cutoff.getTime() - HOUR_MS) });
    await insertItem(tdb.db, { key: kTooOld, listKeys: ["ministries:health"], publishedAt: new Date(cutoff.getTime() - DAY_MS - HOUR_MS) });

    const result = await runDigestIfDue(tdb.db, TZ, RENDER);
    expect(result.ran).toBe(true);

    const deliveredKeys = (await tdb.db.select({ itemKey: deliveries.itemKey }).from(deliveries).where(eq(deliveries.subscriberId, sub))).map(
      (d) => d.itemKey,
    );
    expect(deliveredKeys).toEqual([kInWindow]);
  });

  it("renders a group's digest with items in published_at order, regardless of insertion order", async () => {
    await setLastCutoff(new Date(cutoff.getTime() - DAY_MS));
    await digestSubscriber(tdb.db, "order@example.com", ["ministries:health"]);

    // Inserted in the reverse of their published_at order.
    await insertItem(tdb.db, {
      key: itemKey("LATER"),
      listKeys: ["ministries:health"],
      title: "Later Title",
      publishedAt: new Date(cutoff.getTime() - HOUR_MS),
    });
    await insertItem(tdb.db, {
      key: itemKey("EARLIER"),
      listKeys: ["ministries:health"],
      title: "Earlier Title",
      publishedAt: new Date(cutoff.getTime() - 2 * HOUR_MS),
    });

    const result = await runDigestIfDue(tdb.db, TZ, RENDER);
    expect(result.ran).toBe(true);

    const [job] = await tdb.db.select().from(sendJobs).where(eq(sendJobs.kind, "digest"));
    const earlierIdx = job!.html!.indexOf("Earlier Title");
    const laterIdx = job!.html!.indexOf("Later Title");
    expect(earlierIdx).toBeGreaterThanOrEqual(0);
    expect(laterIdx).toBeGreaterThan(earlierIdx);
  });

  it("integration with As-It-Happens: a subscriber with both timings who already got an item in a digest is skipped by a later As-It-Happens send", async () => {
    await setLastCutoff(new Date(cutoff.getTime() - DAY_MS));
    const both = await digestSubscriber(tdb.db, "both@example.com", ["ministries:health"], true); // as_it_happens true, digest true
    const k = itemKey("BOTH");
    await insertItem(tdb.db, { key: k, listKeys: ["ministries:health"], publishedAt: new Date(cutoff.getTime() - HOUR_MS) });

    const digestResult = await runDigestIfDue(tdb.db, TZ, RENDER);
    expect(digestResult.ran).toBe(true);
    const digestDeliveries = await tdb.db.select().from(deliveries).where(and(eq(deliveries.subscriberId, both), eq(deliveries.itemKey, k)));
    expect(digestDeliveries).toHaveLength(1);
    expect(digestDeliveries[0]!.mode).toBe("digest");

    const { createItemSend } = createItemSending({ render: RENDER });
    await tdb.db.transaction((tx) => createItemSend(tx, k, "as_it_happens"));

    const aihDeliveries = await tdb.db
      .select()
      .from(deliveries)
      .where(and(eq(deliveries.subscriberId, both), eq(deliveries.itemKey, k), eq(deliveries.mode, "as_it_happens")));
    expect(aihDeliveries).toHaveLength(0);
  });

  it("sendDueJobs drops a withdrawn item from an already-built digest and re-renders around the survivors", async () => {
    await setLastCutoff(new Date(cutoff.getTime() - DAY_MS));
    const sub = await digestSubscriber(tdb.db, "withdraw-partial@example.com", ["ministries:health"]);
    const kA = itemKey("A");
    const kB = itemKey("B");
    await insertItem(tdb.db, { key: kA, listKeys: ["ministries:health"], title: "Item A Title", publishedAt: new Date(cutoff.getTime() - 2 * HOUR_MS) });
    await insertItem(tdb.db, { key: kB, listKeys: ["ministries:health"], title: "Item B Title", publishedAt: new Date(cutoff.getTime() - HOUR_MS) });

    const digestResult = await runDigestIfDue(tdb.db, TZ, RENDER);
    expect(digestResult.ran).toBe(true);
    const [job] = await tdb.db.select().from(sendJobs).where(eq(sendJobs.kind, "digest"));
    expect(job!.html).toContain("Item A Title");
    expect(job!.html).toContain("Item B Title");

    // Unpublished after the digest was built, before the sender ran.
    await tdb.db.update(items).set({ withdrawnAt: new Date() }).where(eq(items.key, kB));

    const distribution: DistributionClient = { send: async () => ({ batchId: "batch-withdraw-partial" }) };
    const result = await sendDueJobs({ db: tdb.db, distribution, links: LINKS, render: RENDER });
    expect(result).toEqual({ sent: 1, retried: 0, failed: 0, cancelled: 0, paused: false });

    const sentJob = (await tdb.db.select().from(sendJobs).where(eq(sendJobs.id, job!.id)))[0]!;
    expect(sentJob.html).toContain("Item A Title");
    expect(sentJob.html).not.toContain("Item B Title");

    const remainingDeliveries = await tdb.db.select().from(deliveries).where(and(eq(deliveries.jobId, job!.id), eq(deliveries.subscriberId, sub)));
    expect(remainingDeliveries.map((d) => d.itemKey)).toEqual([kA]);
  });

  it("sendDueJobs cancels a digest job outright once every one of its items has been withdrawn", async () => {
    await setLastCutoff(new Date(cutoff.getTime() - DAY_MS));
    await digestSubscriber(tdb.db, "withdraw-all@example.com", ["ministries:health"]);
    const kA = itemKey("ALLWD-A");
    const kB = itemKey("ALLWD-B");
    await insertItem(tdb.db, { key: kA, listKeys: ["ministries:health"], publishedAt: new Date(cutoff.getTime() - 2 * HOUR_MS) });
    await insertItem(tdb.db, { key: kB, listKeys: ["ministries:health"], publishedAt: new Date(cutoff.getTime() - HOUR_MS) });

    const digestResult = await runDigestIfDue(tdb.db, TZ, RENDER);
    expect(digestResult.ran).toBe(true);
    const [job] = await tdb.db.select().from(sendJobs).where(eq(sendJobs.kind, "digest"));

    await tdb.db.update(items).set({ withdrawnAt: new Date() }).where(inArray(items.key, [kA, kB]));

    const distribution = { send: vi.fn() } as unknown as DistributionClient & { send: ReturnType<typeof vi.fn> };
    const result = await sendDueJobs({ db: tdb.db, distribution, links: LINKS, render: RENDER });
    expect(result).toEqual({ sent: 0, retried: 0, failed: 0, cancelled: 1, paused: false });
    expect(distribution.send).not.toHaveBeenCalled();

    const cancelledJob = (await tdb.db.select().from(sendJobs).where(eq(sendJobs.id, job!.id)))[0]!;
    expect(cancelledJob.status).toBe("cancelled");
  });
});

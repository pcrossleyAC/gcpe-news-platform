import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import type { TestDatabase } from "@gcpe/db-kit";
import { sampleRelease } from "@gcpe/events/testing";
import { createNodTestDb } from "../test/helpers";
import { deliveries, items, jobRecipients, sendJobs, subscribers } from "./db/schema";
import { upsertReleaseItem } from "./items";
import { addSubscriber } from "./subscribers";
import { createItemSending } from "./as-it-happens";
import type { RenderOptions } from "./render";

const PUBLIC_SITE_URL = "https://news.example/site";
const RENDER: RenderOptions = { siteUrl: PUBLIC_SITE_URL, bannerUrl: null };

describe("createItemSend (as_it_happens)", () => {
  let tdb: TestDatabase;
  let createItemSend: ReturnType<typeof createItemSending>["createItemSend"];
  let a: string; // all news, active
  let b: string; // ministries:health, active
  let c: string; // sectors:mining, active
  let d: string; // all news, pending (never activated)
  let e: string; // BOTH '*' and ministries:health, active — must still get exactly one delivery
  let f: string; // all news, active, but as_it_happens=false on the subscriber (digest-only)

  beforeAll(async () => {
    tdb = await createNodTestDb();
    ({ createItemSend } = createItemSending({ render: RENDER }));

    a = (await addSubscriber(tdb.db, { email: "a.all@example.com", lists: "all" })).id;
    b = (await addSubscriber(tdb.db, { email: "b.health@example.com", lists: ["ministries:Health"] })).id;
    c = (await addSubscriber(tdb.db, { email: "c.mining@example.com", lists: ["sectors:Mining"] })).id;
    d = (await addSubscriber(tdb.db, { email: "d.all.unverified@example.com", lists: "all" })).id;
    e = (await addSubscriber(tdb.db, { email: "e.all-and-health@example.com", lists: ["*", "ministries:Health"] })).id;
    f = (await addSubscriber(tdb.db, { email: "f.all.digest-only@example.com", lists: "all" })).id;
    await tdb.db.update(subscribers).set({ verifiedAt: null, status: "pending" }).where(eq(subscribers.id, d));
    // addSubscriber (the public API) always sets the subscriber's own as_it_happens to true;
    // flipping it directly here is the only way to get a digest-only subscriber into a fixture.
    await tdb.db.update(subscribers).set({ asItHappens: false }).where(eq(subscribers.id, f));
  });
  afterAll(async () => {
    await tdb.drop();
  });
  beforeEach(async () => {
    await tdb.pool.query("TRUNCATE deliveries, send_jobs, job_recipients, items CASCADE");
  });

  async function publish(release: typeof sampleRelease): Promise<void> {
    await tdb.db.transaction(async (tx) => {
      await upsertReleaseItem(tx, release, PUBLIC_SITE_URL);
      await createItemSend(tx, release.key, "as_it_happens");
    });
  }

  it("delivers to matching active As-It-Happens subscribers (one each), excluding a digest-only subscriber, and creates one send job mirrored by job_recipients", async () => {
    const release = { ...sampleRelease, ministryKeys: ["Health"], publishFlags: { ...sampleRelease.publishFlags, toSubscribers: true } };
    await publish(release);

    const deliveryRows = await tdb.db.select().from(deliveries).where(eq(deliveries.itemKey, release.key));
    expect(deliveryRows.map((r) => r.subscriberId).sort()).toEqual([a, b, e].sort());
    expect(deliveryRows.map((r) => r.subscriberId)).not.toContain(f);

    const [job] = await tdb.db.select().from(sendJobs).where(eq(sendJobs.itemKey, release.key));
    expect(job).toBeTruthy();
    expect(job!.kind).toBe("as_it_happens");
    expect(job!.subject).toContain(release.documents[0]!.headline);

    const recipientRows = await tdb.db.select().from(jobRecipients).where(eq(jobRecipients.jobId, job!.id));
    expect(recipientRows.map((r) => r.subscriberId).sort()).toEqual(deliveryRows.map((dd) => dd.subscriberId).sort());
  });

  it("a second release.published for the same key creates nothing new", async () => {
    const release = { ...sampleRelease, ministryKeys: ["Health"], publishFlags: { ...sampleRelease.publishFlags, toSubscribers: true } };
    await publish(release);
    await publish(release);

    const deliveryRows = await tdb.db.select().from(deliveries).where(eq(deliveries.itemKey, release.key));
    expect(deliveryRows).toHaveLength(3); // a, b, e -- not doubled
    const jobRows = await tdb.db.select().from(sendJobs).where(eq(sendJobs.itemKey, release.key));
    expect(jobRows).toHaveLength(1);
  });

  it("skips a subscriber who already has a digest delivery for the item", async () => {
    const release = { ...sampleRelease, key: "K-DIGEST-SKIP", ministryKeys: ["Health"], publishFlags: { ...sampleRelease.publishFlags, toSubscribers: true } };
    await tdb.db.transaction((tx) => upsertReleaseItem(tx, release, PUBLIC_SITE_URL));
    await tdb.db.insert(deliveries).values({ itemKey: release.key, subscriberId: a, mode: "digest" });

    await tdb.db.transaction((tx) => createItemSend(tx, release.key, "as_it_happens"));

    const asItHappensRows = await tdb.db.select().from(deliveries).where(and(eq(deliveries.itemKey, release.key), eq(deliveries.mode, "as_it_happens")));
    expect(asItHappensRows.map((r) => r.subscriberId)).not.toContain(a);
    expect(asItHappensRows.map((r) => r.subscriberId).sort()).toEqual([b, e].sort());
  });

  // Review focus: "media member gets one copy" -- media sends are created before
  // As-It-Happens, in the same transaction, so by the time this runs a media-list member
  // already has a 'media' delivery for the item — which must exclude them here exactly like an
  // existing digest delivery does.
  it("skips a subscriber who already has a media delivery for the item", async () => {
    const release = { ...sampleRelease, key: "K-MEDIA-SKIP", ministryKeys: ["Health"], publishFlags: { ...sampleRelease.publishFlags, toSubscribers: true } };
    await tdb.db.transaction((tx) => upsertReleaseItem(tx, release, PUBLIC_SITE_URL));
    await tdb.db.insert(deliveries).values({ itemKey: release.key, subscriberId: a, mode: "media" });

    await tdb.db.transaction((tx) => createItemSend(tx, release.key, "as_it_happens"));

    const asItHappensRows = await tdb.db.select().from(deliveries).where(and(eq(deliveries.itemKey, release.key), eq(deliveries.mode, "as_it_happens")));
    expect(asItHappensRows.map((r) => r.subscriberId)).not.toContain(a);
    expect(asItHappensRows.map((r) => r.subscriberId).sort()).toEqual([b, e].sort());
  });

  it("creates no job when toSubscribers is false", async () => {
    const release = { ...sampleRelease, key: "K-NO-SEND", ministryKeys: ["Health"], publishFlags: { ...sampleRelease.publishFlags, toSubscribers: false } };
    await publish(release);
    expect(await tdb.db.select().from(sendJobs).where(eq(sendJobs.itemKey, release.key))).toHaveLength(0);
    expect(await tdb.db.select().from(deliveries).where(eq(deliveries.itemKey, release.key))).toHaveLength(0);
  });

  it("creates no job when the item has no matching recipients at all", async () => {
    const release = { ...sampleRelease, key: "K-NO-MATCH", ministryKeys: [], publishFlags: { ...sampleRelease.publishFlags, toSubscribers: true } };
    await tdb.db.transaction(async (tx) => {
      await upsertReleaseItem(tx, release, PUBLIC_SITE_URL);
      await tx.update(items).set({ listKeys: [] }).where(eq(items.key, release.key));
      await createItemSend(tx, release.key, "as_it_happens");
    });
    expect(await tdb.db.select().from(sendJobs).where(eq(sendJobs.itemKey, release.key))).toHaveLength(0);
  });
});

describe("createItemSend: '*' matches a ministry-tagged release but not an emergency item", () => {
  let tdb: TestDatabase;
  let createItemSend: ReturnType<typeof createItemSending>["createItemSend"];
  let allNews: string;

  beforeAll(async () => {
    tdb = await createNodTestDb();
    ({ createItemSend } = createItemSending({ render: RENDER }));
    allNews = (await addSubscriber(tdb.db, { email: "star@example.com", lists: "all" })).id;
  });
  afterAll(async () => {
    await tdb.drop();
  });

  it("'*' gets a ministry-tagged release", async () => {
    const release = { ...sampleRelease, key: "K-STAR-MINISTRY", ministryKeys: ["Health"], publishFlags: { ...sampleRelease.publishFlags, toSubscribers: true } };
    await tdb.db.transaction(async (tx) => {
      await upsertReleaseItem(tx, release, PUBLIC_SITE_URL);
      await createItemSend(tx, release.key, "as_it_happens");
    });
    const rows = await tdb.db.select().from(deliveries).where(eq(deliveries.itemKey, release.key));
    expect(rows.map((r) => r.subscriberId)).toContain(allNews);
  });

  it("'*' does not get an emergency item (no ministries: key)", async () => {
    await tdb.db.insert(items).values({
      key: "emergency:K-STAR-EMERGENCY",
      kind: "emergency",
      listKeys: ["emergency:alerts"],
      title: "Evacuation order",
      summary: "Leave the area immediately.",
      url: "https://news.example/site/emergency/1",
      publishedAt: new Date(),
      toSubscribers: true,
    });
    await tdb.db.transaction((tx) => createItemSend(tx, "emergency:K-STAR-EMERGENCY", "emergency"));
    const rows = await tdb.db.select().from(deliveries).where(eq(deliveries.itemKey, "emergency:K-STAR-EMERGENCY"));
    expect(rows).toHaveLength(0);
    expect(await tdb.db.select().from(sendJobs).where(eq(sendJobs.itemKey, "emergency:K-STAR-EMERGENCY"))).toHaveLength(0);
  });
});

describe("createItemSend: emergency recipients ignore the subscriber's own timing preference", () => {
  let tdb: TestDatabase;
  let createItemSend: ReturnType<typeof createItemSending>["createItemSend"];
  let onList: string;
  let notOnList: string;

  beforeAll(async () => {
    tdb = await createNodTestDb();
    ({ createItemSend } = createItemSending({ render: RENDER }));
    onList = (await addSubscriber(tdb.db, { email: "alerts@example.com", lists: ["emergency:alerts"] })).id;
    // Digest-only, as_it_happens false: an emergency send must reach them anyway.
    await tdb.db.update(subscribers).set({ asItHappens: false, digest: true }).where(eq(subscribers.id, onList));
    notOnList = (await addSubscriber(tdb.db, { email: "not-on-alerts@example.com", lists: "all" })).id;
  });
  afterAll(async () => {
    await tdb.drop();
  });

  it("delivers to a digest-only subscriber on the emergency list, and not to an unrelated '*' subscriber", async () => {
    await tdb.db.insert(items).values({
      key: "emergency:K-TIMING",
      kind: "emergency",
      listKeys: ["emergency:alerts"],
      title: "Evacuation order",
      summary: "Leave the area immediately.",
      url: "https://news.example/site/emergency/2",
      publishedAt: new Date(),
      toSubscribers: true,
    });
    await tdb.db.transaction((tx) => createItemSend(tx, "emergency:K-TIMING", "emergency"));
    const rows = await tdb.db.select().from(deliveries).where(eq(deliveries.itemKey, "emergency:K-TIMING"));
    expect(rows.map((r) => r.subscriberId)).toEqual([onList]);
    expect(rows.map((r) => r.subscriberId)).not.toContain(notOnList);
  });
});

// Controller ruling (carried from Task 2): the sender cancels a claimed job of a withdrawn item;
// the release is then republished. createItemSend must clear the cancelled job's unattempted
// deliveries and the job itself, then create a fresh one -- the already-attempted delivery stays
// (its (item, subscriber, mode) primary key then keeps that subscriber out of the fresh insert).
describe("createItemSend re-creates a cancelled job on republish", () => {
  let tdb: TestDatabase;
  let createItemSend: ReturnType<typeof createItemSending>["createItemSend"];
  let attemptedSub: string;
  let freshSub: string;

  beforeAll(async () => {
    tdb = await createNodTestDb();
    ({ createItemSend } = createItemSending({ render: RENDER }));
    attemptedSub = (await addSubscriber(tdb.db, { email: "attempted@example.com", lists: "all" })).id;
    freshSub = (await addSubscriber(tdb.db, { email: "fresh@example.com", lists: "all" })).id;
  });
  afterAll(async () => {
    await tdb.drop();
  });

  it("deletes the cancelled job's unattempted deliveries, keeps the attempted one, and creates a fresh pending job whose recipients exclude the attempted subscriber", async () => {
    const release = { ...sampleRelease, key: "K-CANCELLED-REDO", ministryKeys: ["Health"], publishFlags: { ...sampleRelease.publishFlags, toSubscribers: true } };
    await tdb.db.transaction(async (tx) => {
      await upsertReleaseItem(tx, release, PUBLIC_SITE_URL);
      await createItemSend(tx, release.key, "as_it_happens");
    });
    const [firstJob] = await tdb.db.select().from(sendJobs).where(eq(sendJobs.itemKey, release.key));
    expect(firstJob).toBeTruthy();

    // The sender claimed, then cancelled, the job (it raced a withdraw): one delivery already
    // attempted, one not.
    await tdb.db.update(deliveries).set({ attemptedAt: new Date() }).where(and(eq(deliveries.itemKey, release.key), eq(deliveries.subscriberId, attemptedSub)));
    await tdb.db.update(sendJobs).set({ status: "cancelled" }).where(eq(sendJobs.id, firstJob!.id));

    // Republish.
    await tdb.db.transaction(async (tx) => {
      await upsertReleaseItem(tx, release, PUBLIC_SITE_URL);
      await createItemSend(tx, release.key, "as_it_happens");
    });

    const jobs = await tdb.db.select().from(sendJobs).where(eq(sendJobs.itemKey, release.key));
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.id).not.toBe(firstJob!.id);
    expect(jobs[0]!.status).toBe("pending");

    const recipientRows = await tdb.db.select().from(jobRecipients).where(eq(jobRecipients.jobId, jobs[0]!.id));
    expect(recipientRows.map((r) => r.subscriberId)).toEqual([freshSub]);
    expect(recipientRows.map((r) => r.subscriberId)).not.toContain(attemptedSub);

    // The already-attempted delivery survives, detached from the deleted job.
    const attemptedDeliveryRows = await tdb.db.select().from(deliveries).where(and(eq(deliveries.itemKey, release.key), eq(deliveries.subscriberId, attemptedSub)));
    expect(attemptedDeliveryRows).toHaveLength(1);
    expect(attemptedDeliveryRows[0]!.jobId).toBeNull();
  });
});

describe("recordEmergencyItem", () => {
  let tdb: TestDatabase;
  let sending: ReturnType<typeof createItemSending>;

  beforeAll(async () => {
    tdb = await createNodTestDb();
    sending = createItemSending({ render: RENDER });
    // emergency:alerts already exists as a seeded list (migration 0005) — a subscriber on it
    // so createItemSend actually has a recipient and keeps the job (an empty job is deleted).
    await addSubscriber(tdb.db, { email: "alerts@example.com", lists: ["emergency:alerts"] });
  });
  afterAll(async () => {
    await tdb.drop();
  });

  it("is idempotent on guid: a repeat call returns the same key, reports created: false, and creates no second job", async () => {
    const input = { guid: "guid-abc", title: "Evacuation order", summary: "Leave the area immediately.", url: "https://news.example/site/emergency/1" };
    const first = await sending.recordEmergencyItem(tdb.db, input);
    expect(first.created).toBe(true);

    const second = await sending.recordEmergencyItem(tdb.db, input);
    expect(second).toEqual({ key: first.key, created: false });

    const jobRows = await tdb.db.select().from(sendJobs).where(eq(sendJobs.itemKey, first.key));
    expect(jobRows).toHaveLength(1);
    expect(jobRows[0]!.kind).toBe("emergency");
  });

  it("stamps the given publishedAt, or now() when omitted", async () => {
    const withDate = await sending.recordEmergencyItem(tdb.db, {
      guid: "guid-with-date",
      title: "t",
      summary: "s",
      url: "https://news.example/site/emergency/2",
      publishedAt: "2026-01-01T00:00:00.000Z",
    });
    const [row] = await tdb.db.select().from(items).where(eq(items.key, withDate.key));
    expect(row!.publishedAt.toISOString()).toBe("2026-01-01T00:00:00.000Z");

    const before = new Date();
    const withoutDate = await sending.recordEmergencyItem(tdb.db, { guid: "guid-no-date", title: "t2", summary: "s2", url: "https://news.example/site/emergency/3" });
    const [row2] = await tdb.db.select().from(items).where(eq(items.key, withoutDate.key));
    expect(row2!.publishedAt.getTime()).toBeGreaterThanOrEqual(before.getTime() - 1000);
  });
});

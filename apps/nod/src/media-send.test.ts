import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import type { TestDatabase } from "@gcpe/db-kit";
import { sampleRelease } from "@gcpe/events/testing";
import { createNodTestDb } from "../test/helpers";
import { createItemSending } from "./as-it-happens";
import { deliveries, lists, sendJobs, subscribers } from "./db/schema";
import { upsertReleaseItem, withdrawItem } from "./items";
import { addMediaMember } from "./media-members";
import { createMediaSend } from "./media-send";
import type { RenderOptions } from "./render";
import { addSubscriber } from "./subscribers";

const PUBLIC_SITE_URL = "https://news.example/site";
const RENDER: RenderOptions = { siteUrl: PUBLIC_SITE_URL, bannerUrl: null };
const ACTOR = "staff:jamie";

describe("createMediaSend", () => {
  let tdb: TestDatabase;
  let createItemSend: ReturnType<typeof createItemSending>["createItemSend"];

  beforeAll(async () => {
    tdb = await createNodTestDb();
    ({ createItemSend } = createItemSending({ render: RENDER }));
  });
  afterAll(async () => {
    await tdb.drop();
  });
  beforeEach(async () => {
    // Keeps list_categories/lists ministries rows (seeded by migrations); only this test's own
    // rows need resetting between tests.
    await tdb.db.execute(sql`TRUNCATE deliveries, send_jobs, job_recipients, items, subscriber_history, subscribers CASCADE`);
    await tdb.db.execute(sql`DELETE FROM lists WHERE category = 'media-distribution-lists'`);
    await tdb.db.insert(lists).values([
      { listKey: "media-distribution-lists:budget", category: "media-distribution-lists", key: "budget", name: "Budget", active: true },
      { listKey: "media-distribution-lists:transport", category: "media-distribution-lists", key: "transport", name: "Transport", active: true },
    ]);
  });

  function mediaRelease(over: Partial<typeof sampleRelease> = {}): typeof sampleRelease {
    return {
      ...sampleRelease,
      publishFlags: { ...sampleRelease.publishFlags, toMediaLists: true },
      mediaListKeys: ["budget", "transport"],
      mediaText: "The full release text.",
      ...over,
    };
  }

  async function publishMedia(release: typeof sampleRelease): Promise<boolean> {
    return tdb.db.transaction(async (tx) => {
      await upsertReleaseItem(tx, release, PUBLIC_SITE_URL);
      return createMediaSend(tx, release.key, RENDER);
    });
  }

  it("sends to members of two selected lists, one member on both getting a single delivery", async () => {
    const both = (await addMediaMember(tdb.db, "budget", { email: "both@example.test", source: "manual-media" }, ACTOR)).subscriberId;
    await addMediaMember(tdb.db, "transport", { email: "both@example.test", source: "manual-media" }, ACTOR);
    const budgetOnly = (await addMediaMember(tdb.db, "budget", { email: "budget-only@example.test", source: "manual-media" }, ACTOR)).subscriberId;

    const created = await publishMedia(mediaRelease());
    expect(created).toBe(true);

    const rows = await tdb.db.select().from(deliveries).where(eq(deliveries.itemKey, sampleRelease.key));
    expect(rows.map((r) => r.subscriberId).sort()).toEqual([both, budgetOnly].sort());
    expect(rows.every((r) => r.mode === "media")).toBe(true);
    expect(rows.filter((r) => r.subscriberId === both)).toHaveLength(1); // member of both lists, still one delivery

    const [job] = await tdb.db.select().from(sendJobs).where(eq(sendJobs.jobKey, `media:${sampleRelease.key}`));
    expect(job).toMatchObject({ kind: "media", priority: "media" });
  });

  it("a member of a deactivated list gets nothing", async () => {
    await addMediaMember(tdb.db, "transport", { email: "deactivated-list@example.test", source: "manual-media" }, ACTOR);
    await tdb.db.update(lists).set({ active: false }).where(eq(lists.listKey, "media-distribution-lists:transport"));

    const created = await publishMedia(mediaRelease());
    expect(created).toBe(false); // no active recipients at all -- the job is never created

    const rows = await tdb.db.select().from(deliveries).where(eq(deliveries.itemKey, sampleRelease.key));
    expect(rows).toHaveLength(0);
  });

  it("a non-member public subscriber gets nothing from the media job", async () => {
    await addSubscriber(tdb.db, { email: "public@example.test", lists: "all" });
    await addMediaMember(tdb.db, "budget", { email: "member@example.test", source: "manual-media" }, ACTOR);

    await publishMedia(mediaRelease());

    const rows = await tdb.db.select().from(deliveries).where(eq(deliveries.itemKey, sampleRelease.key));
    expect(rows).toHaveLength(1);
    const [pub] = await tdb.db.select().from(subscribers).where(eq(subscribers.email, "public@example.test"));
    expect(rows.map((r) => r.subscriberId)).not.toContain(pub!.id);
  });

  it("toMediaLists false creates no job", async () => {
    await addMediaMember(tdb.db, "budget", { email: "member2@example.test", source: "manual-media" }, ACTOR);
    const release = mediaRelease({ publishFlags: { ...sampleRelease.publishFlags, toMediaLists: false } });
    const created = await publishMedia(release);
    expect(created).toBe(false);
    expect(await tdb.db.select().from(sendJobs).where(eq(sendJobs.jobKey, `media:${release.key}`))).toHaveLength(0);
  });

  it("a second release.published creates nothing new (ON CONFLICT DO NOTHING on job_key)", async () => {
    await addMediaMember(tdb.db, "budget", { email: "repeat@example.test", source: "manual-media" }, ACTOR);
    const release = mediaRelease();
    expect(await publishMedia(release)).toBe(true);
    expect(await publishMedia(release)).toBe(false);
    expect(await tdb.db.select().from(sendJobs).where(eq(sendJobs.jobKey, `media:${release.key}`))).toHaveLength(1);
  });

  it("media member gets one copy: also matching As-It-Happens gets only the media delivery", async () => {
    const memberId = (await addMediaMember(tdb.db, "budget", { email: "both-channels@example.test", source: "manual-media" }, ACTOR)).subscriberId;
    // addMediaMember never grants a public subscription, and sets as_it_happens false for a
    // brand-new subscriber -- give this member a public subscription and turn as_it_happens
    // back on directly, as a staff member using update() might (global constraints: "a
    // media-created subscriber who picked up a public subscription keeps their own mail"), so
    // this test actually exercises the one-copy guard rather than failing to match at all.
    await tdb.db.execute(sql`INSERT INTO subscriptions (subscriber_id, list_key) VALUES (${memberId}, '*')`);
    await tdb.db.update(subscribers).set({ asItHappens: true }).where(eq(subscribers.id, memberId));

    const release = mediaRelease({ ministryKeys: ["Health"] });
    await tdb.db.transaction(async (tx) => {
      await upsertReleaseItem(tx, release, PUBLIC_SITE_URL);
      await createMediaSend(tx, release.key, RENDER);
      await createItemSend(tx, release.key, "as_it_happens");
    });

    const rows = await tdb.db.select().from(deliveries).where(eq(deliveries.itemKey, release.key));
    const forMember = rows.filter((r) => r.subscriberId === memberId);
    expect(forMember).toHaveLength(1);
    expect(forMember[0]!.mode).toBe("media");
  });

  it("withdraw removes the pending media job", async () => {
    await addMediaMember(tdb.db, "budget", { email: "withdraw-me@example.test", source: "manual-media" }, ACTOR);
    const release = mediaRelease();
    await publishMedia(release);
    await tdb.db.transaction(async (tx) => withdrawItem(tx, release.key));

    expect(await tdb.db.select().from(sendJobs).where(eq(sendJobs.jobKey, `media:${release.key}`))).toHaveLength(0);
    expect(await tdb.db.select().from(deliveries).where(eq(deliveries.itemKey, release.key))).toHaveLength(0);
  });

  it("republish after a withdraw creates a fresh job that skips already-attempted recipients", async () => {
    const already = (await addMediaMember(tdb.db, "budget", { email: "already-sent@example.test", source: "manual-media" }, ACTOR)).subscriberId;
    const fresh = (await addMediaMember(tdb.db, "transport", { email: "fresh@example.test", source: "manual-media" }, ACTOR)).subscriberId;
    const release = mediaRelease();
    await publishMedia(release);

    // Simulate the sender having already handed this delivery off before the withdraw.
    await tdb.db.update(deliveries).set({ attemptedAt: new Date() }).where(eq(deliveries.subscriberId, already));
    await tdb.db.transaction(async (tx) => withdrawItem(tx, release.key));

    // The already-attempted delivery survives withdrawItem (ON DELETE SET NULL, not deleted).
    expect(await tdb.db.select().from(deliveries).where(eq(deliveries.subscriberId, already))).toHaveLength(1);

    const republished = await publishMedia(release);
    expect(republished).toBe(true);

    const rows = await tdb.db.select().from(deliveries).where(eq(deliveries.itemKey, release.key));
    expect(rows.map((r) => r.subscriberId).sort()).toEqual([already, fresh].sort());
    const [job] = await tdb.db.select().from(sendJobs).where(eq(sendJobs.jobKey, `media:${release.key}`));
    expect(job!.status).toBe("pending");
  });
});

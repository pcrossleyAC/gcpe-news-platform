import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import type { TestDatabase } from "@gcpe/db-kit";
import { indexKeysFor } from "@gcpe/events";
import { sampleRelease } from "@gcpe/events/testing";
import { createApp } from "./app";
import { createNodTestDb, createTestApp, envelope, sendEvent } from "../test/helpers";
import { deliveries, items, jobRecipients, sendJobs } from "./db/schema";
import { addSubscriber } from "./subscribers";

describe("items from NRMS release events", () => {
  let tdb: TestDatabase;
  let app: ReturnType<typeof createApp>;

  beforeAll(async () => {
    tdb = await createNodTestDb();
    app = createTestApp(tdb.db);
  });
  afterAll(async () => {
    await tdb.drop();
  });
  beforeEach(async () => {
    await tdb.pool.query("TRUNCATE deliveries, send_jobs, job_recipients, items CASCADE");
  });

  it("published creates the item from the release", async () => {
    const r = { ...sampleRelease, key: "K-ITEM", kind: "releases" as const };
    expect((await sendEvent(app, envelope("nrms", "release.published", r, r.key))).status).toBe(200);
    const [row] = await tdb.db.select().from(items).where(eq(items.key, "K-ITEM"));
    expect(row).toMatchObject({ kind: "release", postKind: "releases", url: "https://news.example/site/releases/K-ITEM", toSubscribers: r.publishFlags.toSubscribers });
    expect(row!.listKeys).toEqual(indexKeysFor(r));
  });

  it("published fills mediaText/mediaListKeys only when toMediaLists is set", async () => {
    const media = {
      ...sampleRelease,
      key: "K-MEDIA-ITEM",
      publishFlags: { ...sampleRelease.publishFlags, toMediaLists: true },
      mediaListKeys: ["Budget", "Transport"],
      mediaText: "The full release text.",
    };
    expect((await sendEvent(app, envelope("nrms", "release.published", media, media.key))).status).toBe(200);
    const [row] = await tdb.db.select().from(items).where(eq(items.key, "K-MEDIA-ITEM"));
    expect(row).toMatchObject({ mediaText: "The full release text.", mediaListKeys: ["media-distribution-lists:budget", "media-distribution-lists:transport"] });

    const nonMedia = { ...sampleRelease, key: "K-NONMEDIA-ITEM" };
    expect((await sendEvent(app, envelope("nrms", "release.published", nonMedia, nonMedia.key))).status).toBe(200);
    const [row2] = await tdb.db.select().from(items).where(eq(items.key, "K-NONMEDIA-ITEM"));
    expect(row2).toMatchObject({ mediaText: null, mediaListKeys: [] });
  });

  it("updated never sends and never creates; it refreshes an existing item", async () => {
    const r = { ...sampleRelease, key: "K-UPD" };
    await sendEvent(app, envelope("nrms", "release.updated", { ...r, notify: true }, r.key));
    expect(await tdb.db.select().from(items).where(eq(items.key, "K-UPD"))).toHaveLength(0);
    await sendEvent(app, envelope("nrms", "release.published", r, r.key));
    const jobsBefore = await tdb.db.select().from(sendJobs);
    const corrected = { ...r, documents: r.documents.map((d) => ({ ...d, headline: "Corrected headline" })), notify: true };
    await sendEvent(app, envelope("nrms", "release.updated", corrected, r.key));
    const [row] = await tdb.db.select().from(items).where(eq(items.key, "K-UPD"));
    expect(row!.title).toBe("Corrected headline");
    expect(await tdb.db.select().from(sendJobs)).toHaveLength(jobsBefore.length);
  });

  it("updated refreshes mediaText/mediaListKeys too, without sending anything", async () => {
    const r = { ...sampleRelease, key: "K-UPD-MEDIA", publishFlags: { ...sampleRelease.publishFlags, toMediaLists: true }, mediaListKeys: ["budget"], mediaText: "Original text." };
    await sendEvent(app, envelope("nrms", "release.published", r, r.key));
    const jobsBefore = await tdb.db.select().from(sendJobs);
    const corrected = { ...r, mediaText: "Corrected text.", notify: true };
    await sendEvent(app, envelope("nrms", "release.updated", corrected, r.key));
    const [row] = await tdb.db.select().from(items).where(eq(items.key, "K-UPD-MEDIA"));
    expect(row).toMatchObject({ mediaText: "Corrected text.", mediaListKeys: ["media-distribution-lists:budget"] });
    expect(await tdb.db.select().from(sendJobs)).toHaveLength(jobsBefore.length);
  });

  // The brief's original wording was "cancels its pending jobs", but the required
  // behaviour (see the fix-round describe block below for why) is to delete the pending job
  // outright, not flip its status -- so a later republish starts clean instead of finding a
  // cancelled job and stale deliveries in its way.
  it("unpublished withdraws the item and deletes its pending jobs", async () => {
    const r = { ...sampleRelease, key: "K-WD" };
    await sendEvent(app, envelope("nrms", "release.published", r, r.key));
    await tdb.db.insert(sendJobs).values({ jobKey: "as_it_happens:K-WD", itemKey: "K-WD", kind: "as_it_happens", subject: "s" }).onConflictDoNothing();
    await sendEvent(app, envelope("nrms", "release.unpublished", { key: "K-WD" }, r.key));
    const [row] = await tdb.db.select().from(items).where(eq(items.key, "K-WD"));
    expect(row!.withdrawnAt).not.toBeNull();
    const jobs = await tdb.db.select().from(sendJobs).where(eq(sendJobs.itemKey, "K-WD"));
    expect(jobs).toHaveLength(0);
  });

  // A release republished after being withdrawn must not stay marked withdrawn.
  it("republishing a withdrawn item clears withdrawn_at", async () => {
    const r = { ...sampleRelease, key: "K-REPUB" };
    await sendEvent(app, envelope("nrms", "release.published", r, r.key));
    await sendEvent(app, envelope("nrms", "release.unpublished", { key: "K-REPUB" }, r.key));
    const [withdrawn] = await tdb.db.select().from(items).where(eq(items.key, "K-REPUB"));
    expect(withdrawn!.withdrawnAt).not.toBeNull();

    await sendEvent(app, envelope("nrms", "release.published", r, r.key));
    const [republished] = await tdb.db.select().from(items).where(eq(items.key, "K-REPUB"));
    expect(republished!.withdrawnAt).toBeNull();
  });

  // Title fallback chain: English headline, else the first document's headline, else the key.
  // Summary is always r.summary (amendment 2026-10-05) regardless of which title fallback fired.
  it("falls back to the first document's headline, and uses r.summary, when there is no English document", async () => {
    const r = {
      ...sampleRelease,
      key: "K-NOENGLISH",
      summary: "Fallback summary from r.summary.",
      documents: [{ ...sampleRelease.documents[0]!, languageId: 1036, headline: "Titre francais", subheadline: "" }],
    };
    await sendEvent(app, envelope("nrms", "release.published", r, r.key));
    const [row] = await tdb.db.select().from(items).where(eq(items.key, "K-NOENGLISH"));
    expect(row!.title).toBe("Titre francais");
    expect(row!.summary).toBe("Fallback summary from r.summary.");
  });

  it("falls back to the release key when there are no documents at all", async () => {
    const r = { ...sampleRelease, key: "K-NODOCS", documents: [] };
    await sendEvent(app, envelope("nrms", "release.published", r, r.key));
    const [row] = await tdb.db.select().from(items).where(eq(items.key, "K-NODOCS"));
    expect(row!.title).toBe("K-NODOCS");
  });

  // Amendment 2026-10-05: the summary is the release's own `summary` field — never the English
  // document's subheadline, even when one is set (this corrects Task 2's original rule).
  it("summary is the release's own summary field, never the English document's subheadline", async () => {
    const r = {
      ...sampleRelease,
      key: "K-SUBHEAD",
      summary: "This is the authoritative release summary.",
      documents: [{ ...sampleRelease.documents[0]!, languageId: 4105, subheadline: "A subheadline that must be ignored." }],
    };
    await sendEvent(app, envelope("nrms", "release.published", r, r.key));
    const [row] = await tdb.db.select().from(items).where(eq(items.key, "K-SUBHEAD"));
    expect(row!.summary).toBe("This is the authoritative release summary.");
  });
});

// Unpublish -> republish must send again. Cancelling the pending job (leaving its
// deliveries behind) silently broke this -- a republish's INSERT...ON CONFLICT DO NOTHING found
// the stale, never-attempted delivery rows already there and inserted nothing, so the cancelled
// job's recipients never got re-matched into a job that would actually send. withdrawItem now
// deletes the pending job's not-yet-attempted deliveries and the job itself, so a republish
// starts clean. A delivery already attempted before the unpublish is kept (that email already
// went out) and is excluded from the republished job.
describe("withdraw then republish resets the pending job", () => {
  let tdb: TestDatabase;
  let app: ReturnType<typeof createApp>;
  let subscriberId: string;

  beforeAll(async () => {
    tdb = await createNodTestDb();
    app = createTestApp(tdb.db);
    subscriberId = (await addSubscriber(tdb.db, { email: "resend@example.com", lists: "all" })).id;
  });
  afterAll(async () => {
    await tdb.drop();
  });
  beforeEach(async () => {
    await tdb.pool.query("TRUNCATE deliveries, send_jobs, job_recipients, items CASCADE");
  });

  it("publish -> unpublish -> republish creates a new pending job whose recipients are the matching subscribers", async () => {
    const r = { ...sampleRelease, key: "K-RESEND", publishFlags: { ...sampleRelease.publishFlags, toSubscribers: true } };
    await sendEvent(app, envelope("nrms", "release.published", r, r.key));
    const [firstJob] = await tdb.db.select().from(sendJobs).where(eq(sendJobs.itemKey, "K-RESEND"));
    expect(firstJob).toBeTruthy();

    await sendEvent(app, envelope("nrms", "release.unpublished", { key: "K-RESEND" }, r.key));
    expect(await tdb.db.select().from(sendJobs).where(eq(sendJobs.itemKey, "K-RESEND"))).toHaveLength(0);
    expect(await tdb.db.select().from(deliveries).where(eq(deliveries.itemKey, "K-RESEND"))).toHaveLength(0);

    await sendEvent(app, envelope("nrms", "release.published", r, r.key));
    const jobsAfter = await tdb.db.select().from(sendJobs).where(eq(sendJobs.itemKey, "K-RESEND"));
    expect(jobsAfter).toHaveLength(1);
    expect(jobsAfter[0]!.status).toBe("pending");
    expect(jobsAfter[0]!.id).not.toBe(firstJob!.id);

    const recipientRows = await tdb.db.select().from(jobRecipients).where(eq(jobRecipients.jobId, jobsAfter[0]!.id));
    expect(recipientRows.map((rr) => rr.subscriberId)).toEqual([subscriberId]);
  });

  it("excludes a subscriber whose delivery was already attempted before the unpublish", async () => {
    const alreadySent = (await addSubscriber(tdb.db, { email: "already-sent@example.com", lists: "all" })).id;
    const r = { ...sampleRelease, key: "K-RESEND-2", publishFlags: { ...sampleRelease.publishFlags, toSubscribers: true } };
    await sendEvent(app, envelope("nrms", "release.published", r, r.key));

    await tdb.db
      .update(deliveries)
      .set({ attemptedAt: new Date() })
      .where(and(eq(deliveries.itemKey, "K-RESEND-2"), eq(deliveries.subscriberId, alreadySent)));

    await sendEvent(app, envelope("nrms", "release.unpublished", { key: "K-RESEND-2" }, r.key));
    // The already-attempted delivery survives the withdrawal, detached from the deleted job.
    const survivingDeliveries = await tdb.db.select().from(deliveries).where(eq(deliveries.itemKey, "K-RESEND-2"));
    expect(survivingDeliveries.map((d) => d.subscriberId)).toEqual([alreadySent]);
    expect(survivingDeliveries[0]!.jobId).toBeNull();

    await sendEvent(app, envelope("nrms", "release.published", r, r.key));
    const [newJob] = await tdb.db.select().from(sendJobs).where(eq(sendJobs.itemKey, "K-RESEND-2"));
    const recipientRows = await tdb.db.select().from(jobRecipients).where(eq(jobRecipients.jobId, newJob!.id));
    expect(recipientRows.map((rr) => rr.subscriberId)).toEqual([subscriberId]);
    expect(recipientRows.map((rr) => rr.subscriberId)).not.toContain(alreadySent);
  });

  it("leaves a 'sent' job of the same item, and a pending job of a different item, untouched", async () => {
    const r = { ...sampleRelease, key: "K-MIXED", publishFlags: { ...sampleRelease.publishFlags, toSubscribers: true } };
    await sendEvent(app, envelope("nrms", "release.published", r, r.key));
    const [job] = await tdb.db.select().from(sendJobs).where(eq(sendJobs.itemKey, "K-MIXED"));
    await tdb.db.update(sendJobs).set({ status: "sent" }).where(eq(sendJobs.id, job!.id));

    await tdb.db.insert(sendJobs).values({ jobKey: "as_it_happens:K-OTHER", itemKey: "K-OTHER", kind: "as_it_happens", subject: "s" });

    await sendEvent(app, envelope("nrms", "release.unpublished", { key: "K-MIXED" }, r.key));

    const sentJob = await tdb.db.select().from(sendJobs).where(eq(sendJobs.id, job!.id));
    expect(sentJob).toHaveLength(1);
    expect(sentJob[0]!.status).toBe("sent");

    const otherJob = await tdb.db.select().from(sendJobs).where(eq(sendJobs.itemKey, "K-OTHER"));
    expect(otherJob).toHaveLength(1);
    expect(otherJob[0]!.status).toBe("pending");
  });

  // A job the sender has currently claimed (locked_until in the future, status
  // still 'pending' -- claimOneJob doesn't flip status until its terminal write) must survive
  // an unpublish untouched, deliveries included -- the send may already be in flight with
  // Distribution, and deleting the job out from under it would let a republish create a second
  // job and double-send to every recipient.
  it("leaves a currently-claimed (locked) pending job and its deliveries alone; republishing finds it rather than creating a new one", async () => {
    const r = { ...sampleRelease, key: "K-LOCKED", publishFlags: { ...sampleRelease.publishFlags, toSubscribers: true } };
    await sendEvent(app, envelope("nrms", "release.published", r, r.key));
    const [job] = await tdb.db.select().from(sendJobs).where(eq(sendJobs.itemKey, "K-LOCKED"));
    await tdb.pool.query("UPDATE send_jobs SET locked_until = now() + interval '5 minutes' WHERE id = $1", [job!.id]);

    await sendEvent(app, envelope("nrms", "release.unpublished", { key: "K-LOCKED" }, r.key));

    const jobsAfterUnpublish = await tdb.db.select().from(sendJobs).where(eq(sendJobs.itemKey, "K-LOCKED"));
    expect(jobsAfterUnpublish).toHaveLength(1);
    expect(jobsAfterUnpublish[0]!.id).toBe(job!.id);
    expect(jobsAfterUnpublish[0]!.status).toBe("pending");
    const deliveriesAfterUnpublish = await tdb.db.select().from(deliveries).where(eq(deliveries.itemKey, "K-LOCKED"));
    expect(deliveriesAfterUnpublish.length).toBeGreaterThan(0);

    await sendEvent(app, envelope("nrms", "release.published", r, r.key));
    const jobsAfterRepublish = await tdb.db.select().from(sendJobs).where(eq(sendJobs.itemKey, "K-LOCKED"));
    expect(jobsAfterRepublish).toHaveLength(1);
    expect(jobsAfterRepublish[0]!.id).toBe(job!.id); // same job -- no new one created
  });
});

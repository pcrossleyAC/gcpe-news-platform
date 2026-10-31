import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import type { TestDatabase } from "@gcpe/db-kit";
import { indexKeysFor } from "@gcpe/events";
import { sampleRelease } from "@gcpe/events/testing";
import { createNodTestDb } from "../test/helpers";
import { createItemSending } from "./as-it-happens";
import { releaseAudience } from "./audience";
import { lists, nodSettings, subscribers } from "./db/schema";
import { digestCutoff, runDigestIfDue } from "./digest";
import { upsertReleaseItem } from "./items";
import { addMediaMember } from "./media-members";
import { createMediaSend } from "./media-send";
import { addSubscriber } from "./subscribers";

const RENDER = { siteUrl: "https://news.example", bannerUrl: null };
const TZ = "America/Vancouver";
const HOUR_MS = 3_600_000;

/**
 * Suite review R6 fix round 1: the Publish dialogs' numbers must be the people NoD's own senders
 * reach. Each case seeds subscribers, asks {@link releaseAudience}, then runs the real send paths
 * in NoD's own order (media, then As-It-Happens, as app.ts's onPublished; then the 5 pm digest)
 * and compares the preview with the deliveries actually created.
 */
describe("releaseAudience matches what the senders deliver", () => {
  let tdb: TestDatabase;
  beforeAll(async () => {
    tdb = await createNodTestDb();
  });
  afterAll(async () => {
    await tdb.drop();
  });
  beforeEach(async () => {
    await tdb.pool.query("TRUNCATE deliveries, send_jobs, job_recipients, items, digest_runs, subscriptions, subscribers, lists CASCADE");
  });

  const mk = "ministries:transportation-and-transit";

  async function seed(): Promise<void> {
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
    await addMediaMember(db, "budget", { email: "pubmedia@x.test", source: "manual-media" }, "t");
    await addMediaMember(db, "budget", { email: "mediaonly@x.test", source: "manual-media" }, "t");
    await addMediaMember(db, "retired", { email: "retiredmedia@x.test", source: "manual-media" }, "t");
    const dis = await addSubscriber(db, { email: "disabled@x.test", lists: [mk], digest: true });
    await db.update(subscribers).set({ status: "disabled" }).where(eq(subscribers.id, dis.id));
  }

  async function sendAll(release: typeof sampleRelease): Promise<Record<string, number>> {
    const cutoff = digestCutoff(new Date(), TZ);
    await tdb.db.update(nodSettings).set({ lastDigestCutoff: new Date(cutoff.getTime() - 24 * HOUR_MS), paused: false }).where(eq(nodSettings.id, 1));
    const { createItemSend } = createItemSending({ render: RENDER });
    await tdb.db.transaction(async (tx) => {
      await upsertReleaseItem(tx, { ...release, publishDate: new Date(cutoff.getTime() - HOUR_MS).toISOString() }, RENDER.siteUrl);
      await createMediaSend(tx, release.key, RENDER);
      await createItemSend(tx, release.key, "as_it_happens");
    });
    await runDigestIfDue(tdb.db, TZ, RENDER);
    const { rows } = await tdb.db.execute<{ mode: string; n: number }>(sql`SELECT mode, count(DISTINCT subscriber_id)::int AS n FROM deliveries GROUP BY mode`);
    return Object.fromEntries(rows.map((r) => [r.mode, r.n]));
  }

  it("a release to subscribers and a media list: emailed now, in the digest, and media contacts", async () => {
    await seed();
    const release = { ...sampleRelease, publishFlags: { ...sampleRelease.publishFlags, toSubscribers: true, toMediaLists: true }, mediaListKeys: ["budget", "retired"], mediaText: "t" };
    const preview = await releaseAudience(tdb.db, {
      listKeys: indexKeysFor(release),
      mediaListKeys: ["media-distribution-lists:budget", "media-distribution-lists:retired"],
      toSubscribers: true,
      postKind: release.kind,
    });
    const sent = await sendAll(release);
    // aih and both now (pubmedia gets only the media copy); digestonly and both at 5 pm;
    // pubmedia and mediaonly on the media list (retired list and disabled get nothing).
    expect(sent).toEqual({ as_it_happens: 2, digest: 2, media: 2 });
    expect(preview).toEqual({ asItHappens: sent.as_it_happens, digest: sent.digest, mediaContacts: sent.media });
  });

  it("not to subscribers: nobody now or in the digest; media only", async () => {
    await seed();
    const release = { ...sampleRelease, publishFlags: { ...sampleRelease.publishFlags, toSubscribers: false, toMediaLists: true }, mediaListKeys: ["budget"], mediaText: "t" };
    const preview = await releaseAudience(tdb.db, { listKeys: indexKeysFor(release), mediaListKeys: ["media-distribution-lists:budget"], toSubscribers: false, postKind: release.kind });
    const sent = await sendAll(release);
    expect(sent).toEqual({ media: 2 });
    expect(preview).toEqual({ asItHappens: 0, digest: 0, mediaContacts: 2 });
  });

  it("an advisory is never in the digest, as the digest leaves advisories out", async () => {
    await seed();
    const release = { ...sampleRelease, kind: "advisories" as const, publishFlags: { ...sampleRelease.publishFlags, toSubscribers: true, toMediaLists: false }, mediaListKeys: [], mediaText: null };
    const preview = await releaseAudience(tdb.db, { listKeys: indexKeysFor(release), mediaListKeys: [], toSubscribers: true, postKind: "advisories" });
    const sent = await sendAll(release);
    expect(sent.digest ?? 0).toBe(0);
    expect(preview).toEqual({ asItHappens: sent.as_it_happens ?? 0, digest: 0, mediaContacts: 0 });
  });
});

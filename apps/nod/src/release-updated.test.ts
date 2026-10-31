/**
 * Phase 3e cutover (spec §8 safety point 3): `nrms:replay-to-news-api` re-sends every
 * published, live release as a `release.updated` event with `notify: false`. This pins that
 * NoD never sends an email for it -- `release.updated` is handled (apps/nod/src/items.ts's
 * `refreshReleaseItem`, wired in apps/nod/src/app.ts), and it refreshes an existing item's
 * title/summary/list keys/URL, but it never creates a delivery or a send job. Also checks
 * `notify: true` (the shape a real correction, not just a replay, uses) for the same reason:
 * NoD ignores the event's `notify` flag entirely, in both directions.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { TestDatabase } from "@gcpe/db-kit";
import { sampleRelease } from "@gcpe/events/testing";
import { createApp } from "./app";
import { createNodTestDb, envelope, sendEvent } from "../test/helpers";
import { deliveries, items, sendJobs } from "./db/schema";
import type { DistributionClient } from "./distribution-client";
import { sendDueJobs } from "./send-jobs";
import { addSubscriber } from "./subscribers";

describe("release.updated from nrms produces no NoD send", () => {
  let tdb: TestDatabase;
  let app: ReturnType<typeof createApp>;

  beforeAll(async () => {
    tdb = await createNodTestDb();
    app = createApp({
      db: tdb.db,
      auth: {},
      eventSecrets: { nrms: "nrms-secret", core: "core-secret" },
      render: { siteUrl: "https://news.gov.bc.ca", bannerUrl: null },
    });
  });
  afterAll(async () => {
    await tdb.drop();
  });
  beforeEach(async () => {
    await tdb.pool.query("TRUNCATE deliveries, send_jobs, job_recipients, items CASCADE");
  });

  it.each([false, true])("notify: %s never creates a delivery or a send job, even with no existing item", async (notify) => {
    const release = { ...sampleRelease, key: `REPLAY-${notify}`, publishFlags: { ...sampleRelease.publishFlags, toSubscribers: true }, notify };
    const event = envelope("nrms", "release.updated", release, release.key);

    const res = await sendEvent(app, event);
    expect(res.status).toBe(200);
    // Applied (refreshReleaseItem ran -- there's just no existing item for it to refresh),
    // never "ignored": release.updated is a handled event type now, it just never sends.
    expect(res.body).toEqual({ outcome: "applied" });

    const itemRows = await tdb.db.select().from(items).where(eq(items.key, release.key));
    expect(itemRows).toHaveLength(0);
    const deliveryRows = await tdb.db.select().from(deliveries).where(eq(deliveries.itemKey, release.key));
    expect(deliveryRows).toHaveLength(0);
    const jobRows = await tdb.db.select().from(sendJobs).where(eq(sendJobs.itemKey, release.key));
    expect(jobRows).toHaveLength(0);
  });
});

/**
 * Owner decision 2026-10-31: a republish emails anyone again only when the editor ticked "Also
 * email it again?" (the event's `emailAgain`). Without it -- a correction (release.updated) or a
 * republish after an unpublish (release.published again) -- nobody who already got the release
 * is emailed again; with it, those people get a corrected copy, once per correction.
 */
describe("a republish re-emails only when asked", () => {
  let tdb: TestDatabase;
  let app: ReturnType<typeof createApp>;
  const distribution = { send: async () => ({ batchId: "00000000-0000-4000-8000-0000000000ab" }) } as unknown as DistributionClient;
  const LINKS = { pageUrl: "https://news.example/subscribe/manage", subscribeApiUrl: "https://news.example/api/Subscribe", linkSecret: "test-link-secret-at-least-32-chars-long" };
  const RENDER = { siteUrl: "https://news.gov.bc.ca", bannerUrl: null };

  beforeAll(async () => {
    tdb = await createNodTestDb();
    app = createApp({ db: tdb.db, auth: {}, eventSecrets: { nrms: "nrms-secret", core: "core-secret" }, render: RENDER });
  });
  afterAll(async () => {
    await tdb.drop();
  });

  const release = { ...sampleRelease, key: "CORRECTED-1", publishFlags: { ...sampleRelease.publishFlags, toSubscribers: true } };
  const emailAgain = (seq: number) => ({ seq, subscribers: true, mediaLists: true, requestedBy: "Pat Editor", requestedAt: "2026-10-31T21:15:00.000Z" });
  const counts = async () => {
    const jobs = await tdb.db.select({ key: sendJobs.jobKey, subject: sendJobs.subject }).from(sendJobs).where(eq(sendJobs.itemKey, release.key));
    const d = await tdb.db.select().from(deliveries).where(eq(deliveries.itemKey, release.key));
    return { jobs: jobs.map((j) => j.key).sort(), subjects: jobs.map((j) => j.subject).sort(), deliveries: d.length };
  };

  it("never without the tick; a corrected copy per correction with it", async () => {
    await addSubscriber(tdb.db, { email: "reader@x.test", lists: "all" });
    expect((await sendEvent(app, envelope("nrms", "release.published", release, release.key))).body).toEqual({ outcome: "applied" });
    await sendDueJobs({ db: tdb.db, distribution, links: LINKS, render: RENDER });
    const first = await counts();
    expect(first.jobs).toEqual([`as_it_happens:${release.key}`]);
    expect(first.deliveries).toBe(1);

    // A correction, then unpublish and publish again: nobody is emailed again.
    await sendEvent(app, envelope("nrms", "release.updated", { ...release, notify: true }, release.key));
    await sendEvent(app, envelope("nrms", "release.unpublished", { key: release.key }, release.key));
    await sendEvent(app, envelope("nrms", "release.published", release, release.key));
    expect(await counts()).toEqual(first);

    // Asked for: a corrected copy, then another for a second correction (this time by publishing again).
    const corrected = { ...release, documents: [{ ...release.documents[0]!, headline: "Fixed headline" }] };
    await sendEvent(app, envelope("nrms", "release.updated", { ...corrected, notify: true, emailAgain: emailAgain(1) }, release.key));
    // Sent before the unpublish below (which, like any unpublish, would stop it if it hadn't gone yet).
    await sendDueJobs({ db: tdb.db, distribution, links: LINKS, render: RENDER });
    await sendEvent(app, envelope("nrms", "release.unpublished", { key: release.key }, release.key));
    await sendEvent(app, envelope("nrms", "release.published", { ...corrected, emailAgain: emailAgain(2) }, release.key));
    const after = await counts();
    expect(after.jobs).toEqual([`as_it_happens:${release.key}`, `correction:1:as_it_happens:${release.key}`, `correction:2:as_it_happens:${release.key}`]);
    expect(after.subjects.filter((s) => s?.startsWith("Corrected: "))).toEqual(["Corrected: BC Gov News - Fixed headline", "Corrected: BC Gov News - Fixed headline"]);
    expect(after.deliveries).toBe(3);
  });
});

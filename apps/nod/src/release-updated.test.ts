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

describe("release.updated from nrms produces no NoD send", () => {
  let tdb: TestDatabase;
  let app: ReturnType<typeof createApp>;

  beforeAll(async () => {
    tdb = await createNodTestDb();
    app = createApp({
      db: tdb.db,
      auth: {},
      eventSecrets: { nrms: "nrms-secret", core: "core-secret" },
      handlerOptions: { publicSiteUrl: "https://news.gov.bc.ca", manageUrl: "https://news.gov.bc.ca/manage" },
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

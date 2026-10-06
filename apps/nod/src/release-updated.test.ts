/**
 * Phase 3e cutover (spec §8 safety point 3): `nrms:replay-to-news-api` re-sends every
 * published, live release as a `release.updated` event with `notify: false`. This pins that
 * NoD never sends an email for it -- NoD's event receiver only wires a handler for
 * `release.published` from `nrms` (apps/nod/src/app.ts:32), so `release.updated` (whatever its
 * `notify` flag) is recorded "ignored" and produces no delivery/send job. Also checks
 * `notify: true` (the shape a real correction, not just a replay, uses) for the same reason:
 * NoD ignores the event *type*, never looks at `notify` at all.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { TestDatabase } from "@gcpe/db-kit";
import { sampleRelease } from "@gcpe/events/testing";
import { createApp } from "./app";
import { createNodTestDb, envelope, sendEvent } from "../test/helpers";
import { deliveries, sendJobs } from "./db/schema";

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
    await tdb.pool.query("TRUNCATE deliveries, send_jobs, job_recipients CASCADE");
  });

  it.each([false, true])("notify: %s is ignored -- no delivery, no send job", async (notify) => {
    const release = { ...sampleRelease, key: `REPLAY-${notify}`, publishFlags: { ...sampleRelease.publishFlags, toSubscribers: true }, notify };
    const event = envelope("nrms", "release.updated", release, release.key);

    const res = await sendEvent(app, event);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ outcome: "ignored" });

    const deliveryRows = await tdb.db.select().from(deliveries).where(eq(deliveries.itemKey, release.key));
    expect(deliveryRows).toHaveLength(0);
    const jobRows = await tdb.db.select().from(sendJobs).where(eq(sendJobs.itemKey, release.key));
    expect(jobRows).toHaveLength(0);
  });
});

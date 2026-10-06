import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { TestDatabase } from "@gcpe/db-kit";
import { sampleRelease } from "@gcpe/events/testing";
import { outboxEvents, type SubscriberConfig } from "@gcpe/events";
import { createNewsTestDb } from "../test/helpers";
import { createProjectionHandlers } from "./projections";

const subscribers: SubscriberConfig[] = [{ name: "public-site", url: "http://site.invalid/events", secret: "s", types: ["site.rebuild_requested"] }];
const event = (type: string, data: unknown) => ({
  id: crypto.randomUUID(), type, version: 1, source: "nrms", aggregateId: "k", sequence: 1,
  occurredAt: "2026-10-03T17:00:00Z", correlationId: "11111111-1111-4111-8111-111111111111", data,
});

describe("News API rebuild requests", () => {
  let tdb: TestDatabase;
  beforeAll(async () => { tdb = await createNewsTestDb(); });
  afterAll(async () => { await tdb.drop(); });
  beforeEach(async () => { await tdb.pool.query("TRUNCATE outbox_events, outbox_deliveries, aggregate_sequences, posts CASCADE"); });

  it("enqueues site.rebuild_requested in the same transaction as release.published", async () => {
    const handlers = createProjectionHandlers({ subscribers });
    await tdb.db.transaction((tx) => handlers["release.published"]!(tx, event("release.published", sampleRelease)));
    const rows = await tdb.db.select().from(outboxEvents);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ type: "site.rebuild_requested", aggregateId: `post:${sampleRelease.key.toLowerCase()}` });
    expect((rows[0]!.envelope as { data: unknown; correlationId: string })).toMatchObject({
      data: { pages: ["home", `post:${sampleRelease.key}`] },
      correlationId: "11111111-1111-4111-8111-111111111111",
    });
  });

  it("enqueues nothing when the projection transaction rolls back", async () => {
    const handlers = createProjectionHandlers({ subscribers });
    await expect(tdb.db.transaction(async (tx) => {
      await handlers["release.published"]!(tx, event("release.published", sampleRelease));
      throw new Error("rollback");
    })).rejects.toThrow("rollback");
    expect(await tdb.db.select().from(outboxEvents)).toHaveLength(0);
  });

  it("enqueues a rebuild for unpublish too", async () => {
    const handlers = createProjectionHandlers({ subscribers });
    await tdb.db.transaction((tx) => handlers["release.unpublished"]!(tx, event("release.unpublished", { key: sampleRelease.key })));
    expect(await tdb.db.select().from(outboxEvents)).toHaveLength(1);
  });

  it("still applies with no subscribers configured (rule 3) and writes no deliveries", async () => {
    const handlers = createProjectionHandlers();
    await tdb.db.transaction((tx) => handlers["release.published"]!(tx, event("release.published", sampleRelease)));
    const { rows } = await tdb.pool.query("SELECT count(*)::int AS n FROM outbox_deliveries");
    expect(rows[0].n).toBe(0);
  });

  it("enqueues site.rebuild_requested for a home site.content.changed, in the same transaction", async () => {
    const handlers = createProjectionHandlers({ subscribers });
    const homeData = {
      entity: "home",
      topPostKey: null,
      featurePostKey: null,
      liveWebcastFlashMediaManifestUrl: null,
      liveWebcastM3uPlaylist: null,
      granville: null,
      timestamp: "2026-10-03T17:00:00Z",
    };
    await tdb.db.transaction((tx) => handlers["site.content.changed"]!(tx, event("site.content.changed", homeData)));
    const rows = await tdb.db.select().from(outboxEvents);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ type: "site.rebuild_requested", aggregateId: "site:home-page" });
    expect((rows[0]!.envelope as { data: unknown }).data).toMatchObject({ pages: ["home"] });
  });

  it("enqueues no rebuild for a non-home site.content.changed", async () => {
    const handlers = createProjectionHandlers({ subscribers });
    const linksData = { entity: "resourceLinks", links: [], timestamp: "2026-10-03T17:00:00Z" };
    await tdb.db.transaction((tx) => handlers["site.content.changed"]!(tx, event("site.content.changed", linksData)));
    expect(await tdb.db.select().from(outboxEvents)).toHaveLength(0);
  });

  it("enqueues nothing for a home site.content.changed when the transaction rolls back", async () => {
    const handlers = createProjectionHandlers({ subscribers });
    const homeData = {
      entity: "home",
      topPostKey: null,
      featurePostKey: null,
      liveWebcastFlashMediaManifestUrl: null,
      liveWebcastM3uPlaylist: null,
      granville: null,
      timestamp: "2026-10-03T17:00:00Z",
    };
    await expect(
      tdb.db.transaction(async (tx) => {
        await handlers["site.content.changed"]!(tx, event("site.content.changed", homeData));
        throw new Error("rollback");
      }),
    ).rejects.toThrow("rollback");
    expect(await tdb.db.select().from(outboxEvents)).toHaveLength(0);
  });
});

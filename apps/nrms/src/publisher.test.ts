import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { TestDatabase } from "@gcpe/db-kit";
import { outboxEvents, parseEvent, type SubscriberConfig } from "@gcpe/events";
import { createNrmsTestDb, sampleDraft } from "../test/helpers";
import { createDraft, getRelease, scheduleRelease } from "./releases";
import { publishDue } from "./publisher";

const subscribers: SubscriberConfig[] = [{ name: "news-api", url: "http://news.invalid/events", secret: "s", types: ["release.published"] }];
const NOW = new Date("2026-10-03T17:00:30Z");

describe("publishDue", () => {
  let tdb: TestDatabase;
  beforeAll(async () => { tdb = await createNrmsTestDb(); });
  afterAll(async () => { await tdb.drop(); });
  beforeEach(async () => { await tdb.pool.query("TRUNCATE releases, outbox_events, outbox_deliveries, aggregate_sequences CASCADE"); });

  it("publishes due releases with a complete release.published event", async () => {
    await createDraft(tdb.db, sampleDraft);
    await scheduleRelease(tdb.db, sampleDraft.key, new Date("2026-10-03T17:00:00Z"));
    expect(await publishDue({ db: tdb.db, subscribers, now: () => NOW })).toEqual({ published: [sampleDraft.key] });
    expect(await getRelease(tdb.db, sampleDraft.key)).toMatchObject({ status: "published", publishedAt: NOW });
    const [row] = await tdb.db.select().from(outboxEvents);
    const env = parseEvent(row!.envelope);
    expect(env).toMatchObject({ type: "release.published", source: "nrms", aggregateId: sampleDraft.key });
    expect(env.data).toMatchObject({ key: sampleDraft.key, kind: "releases", publishDate: NOW.toISOString(), timestamp: NOW.toISOString(), atomId: null, renditions: null });
  });

  it("leaves drafts and future releases alone", async () => {
    await createDraft(tdb.db, sampleDraft);
    await createDraft(tdb.db, { ...sampleDraft, key: "FUTURE-1" });
    await scheduleRelease(tdb.db, "FUTURE-1", new Date("2026-10-03T18:00:00Z"));
    expect(await publishDue({ db: tdb.db, subscribers, now: () => NOW })).toEqual({ published: [] });
  });

  it("two concurrent publishDue calls publish each release once", async () => {
    for (let i = 0; i < 10; i++) {
      await createDraft(tdb.db, { ...sampleDraft, key: `K-${i}` });
      await scheduleRelease(tdb.db, `K-${i}`, new Date("2026-10-03T17:00:00Z"));
    }
    const [a, b] = await Promise.all([
      publishDue({ db: tdb.db, subscribers, now: () => NOW }),
      publishDue({ db: tdb.db, subscribers, now: () => NOW }),
    ]);
    expect([...a.published, ...b.published].sort()).toEqual(Array.from({ length: 10 }, (_, i) => `K-${i}`).sort());
    const { rows } = await tdb.pool.query("SELECT count(*)::int AS n FROM outbox_events WHERE type = 'release.published'");
    expect(rows[0].n).toBe(10);
  });
});

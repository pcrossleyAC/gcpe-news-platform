import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db, TestDatabase } from "@gcpe/db-kit";
import { outboxEvents, parseEvent, type SubscriberConfig } from "@gcpe/events";
import { createNrmsTestDb, sampleDraft } from "../test/helpers";
import { createDraft, getRelease, scheduleRelease } from "./releases";
import { releases } from "./db/schema";
import { publishDue, startPublisher } from "./publisher";

const subscribers: SubscriberConfig[] = [{ name: "news-api", url: "http://news.invalid/events", secret: "s", types: ["release.published"] }];
const NOW = new Date("2026-10-03T17:00:30Z");

/** Polls a condition with real timers, for tests that can't use vi.useFakeTimers (they need
 * a real setInterval racing against real async work). */
async function waitUntil(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("publishDue", () => {
  let tdb: TestDatabase;
  beforeAll(async () => { tdb = await createNrmsTestDb(); });
  afterAll(async () => { await tdb.drop(); });
  beforeEach(async () => { await tdb.pool.query("TRUNCATE releases, outbox_events, outbox_deliveries, aggregate_sequences CASCADE"); });

  it("publishes due releases with a complete release.published event", async () => {
    await createDraft(tdb.db, sampleDraft);
    await scheduleRelease(tdb.db, sampleDraft.key, new Date("2026-10-03T17:00:00Z"));
    expect(await publishDue({ db: tdb.db, subscribers, now: () => NOW })).toEqual({ published: [sampleDraft.key], failed: [] });
    expect(await getRelease(tdb.db, sampleDraft.key)).toMatchObject({ status: "published", publishedAt: NOW });
    const [row] = await tdb.db.select().from(outboxEvents);
    const env = parseEvent(row!.envelope);
    expect(env).toMatchObject({ type: "release.published", source: "nrms", aggregateId: sampleDraft.key });
    expect(env.data).toMatchObject({ key: sampleDraft.key, kind: "releases", publishDate: NOW.toISOString(), timestamp: NOW.toISOString(), atomId: null, renditions: null });
  });

  // P2-R22 D1: with no test clock, "due" and published_at come from the database's clock, and
  // the event's publishDate states exactly the instant stored in published_at (not a rounded
  // or JS-clock copy of it).
  it("publishes by the database clock, and the event's publishDate equals the stored published_at exactly", async () => {
    await createDraft(tdb.db, sampleDraft);
    await scheduleRelease(tdb.db, sampleDraft.key, new Date("2026-10-03T17:00:00Z"));
    expect(await publishDue({ db: tdb.db, subscribers })).toEqual({ published: [sampleDraft.key], failed: [] });
    const { rows } = await tdb.pool.query<{ same: boolean }>(
      `SELECT r.published_at = (e.envelope->'data'->>'publishDate')::timestamptz AS same
         FROM releases r JOIN outbox_events e ON e.aggregate_id = r.key
        WHERE r.key = $1`,
      [sampleDraft.key],
    );
    expect(rows).toEqual([{ same: true }]);
  });

  it("leaves drafts and future releases alone", async () => {
    await createDraft(tdb.db, sampleDraft);
    await createDraft(tdb.db, { ...sampleDraft, key: "FUTURE-1" });
    await scheduleRelease(tdb.db, "FUTURE-1", new Date("2026-10-03T18:00:00Z"));
    expect(await publishDue({ db: tdb.db, subscribers, now: () => NOW })).toEqual({ published: [], failed: [] });
  });

  it("two concurrent publishDue calls partition the due releases without publishing any twice", async () => {
    for (let i = 0; i < 10; i++) {
      await createDraft(tdb.db, { ...sampleDraft, key: `K-${i}` });
      await scheduleRelease(tdb.db, `K-${i}`, new Date("2026-10-03T17:00:00Z"));
    }
    const [a, b] = await Promise.all([
      publishDue({ db: tdb.db, subscribers, now: () => NOW }),
      publishDue({ db: tdb.db, subscribers, now: () => NOW }),
    ]);
    expect(a.failed).toEqual([]);
    expect(b.failed).toEqual([]);
    expect([...a.published, ...b.published].sort()).toEqual(Array.from({ length: 10 }, (_, i) => `K-${i}`).sort());
    const { rows } = await tdb.pool.query("SELECT count(*)::int AS n FROM outbox_events WHERE type = 'release.published'");
    expect(rows[0].n).toBe(10);
  });

  it("does not wait on a release locked by another transaction (FOR UPDATE SKIP LOCKED)", async () => {
    for (let i = 0; i < 3; i++) {
      await createDraft(tdb.db, { ...sampleDraft, key: `S-${i}` });
      await scheduleRelease(tdb.db, `S-${i}`, new Date("2026-10-03T17:00:00Z"));
    }
    const locker = await tdb.pool.connect();
    await locker.query("BEGIN");
    await locker.query("SELECT key FROM releases WHERE key = $1 FOR UPDATE", ["S-0"]);
    try {
      const result = await Promise.race([
        publishDue({ db: tdb.db, subscribers, now: () => NOW }),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("publishDue waited on the locked row instead of skipping it")), 5000)),
      ]);
      expect(result.published.sort()).toEqual(["S-1", "S-2"]);
      expect(result.failed).toEqual([]);
    } finally {
      await locker.query("ROLLBACK");
      locker.release();
    }
  }, 7000);

  it("isolates a poison release (over MAX_EVENT_BYTES) so it fails without blocking releases due after it", async () => {
    // createDraft now rejects an oversized draft outright (ReleaseTooLargeError); insert
    // directly to simulate a release that reached 'scheduled' despite that guard (e.g. data
    // from before the guard existed) and prove publishDue's own isolation independently.
    const poisonKey = "POISON-1";
    const { key, kind, ...content } = {
      ...sampleDraft,
      key: poisonKey,
      documents: [{ ...sampleDraft.documents[0]!, detailsHtml: "x".repeat(1_100_000) }],
    };
    await tdb.db.insert(releases).values({
      key,
      kind,
      status: "scheduled",
      publishAt: new Date("2026-10-03T16:59:00Z"), // due before the normal release below
      content,
    });
    await createDraft(tdb.db, sampleDraft);
    await scheduleRelease(tdb.db, sampleDraft.key, new Date("2026-10-03T17:00:00Z"));

    const result = await publishDue({ db: tdb.db, subscribers, now: () => NOW });
    expect(result.published).toEqual([sampleDraft.key]);
    expect(result.failed).toEqual([poisonKey]);

    const poisonRow = await getRelease(tdb.db, poisonKey);
    expect(poisonRow?.status).toBe("failed");
    expect(poisonRow?.lastError).toBeTruthy();
    expect(poisonRow!.lastError!.length).toBeLessThanOrEqual(500);

    expect(await getRelease(tdb.db, sampleDraft.key)).toMatchObject({ status: "published" });
  });
});

describe("startPublisher", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("logs a publishDue error and keeps ticking; stop() awaits an in-flight run", async () => {
    let calls = 0;
    let resolveSecondRun: (() => void) | undefined;
    const fakeDb = {
      transaction: vi.fn(async () => {
        calls++;
        if (calls === 1) throw new Error("boom");
        await new Promise<void>((resolve) => {
          resolveSecondRun = resolve;
        });
        return null;
      }),
    } as unknown as Db;

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const stop = startPublisher({ db: fakeDb, subscribers, intervalMs: 10 });

    await waitUntil(() => calls >= 1);
    await waitUntil(() => errorSpy.mock.calls.length >= 1);
    expect(errorSpy.mock.calls.some(([first]) => first === "[nrms] publish failed")).toBe(true);

    // The loop kept running after the first tick's error instead of dying with it.
    await waitUntil(() => calls >= 2);

    let stopped = false;
    const stopPromise = stop().then(() => {
      stopped = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(stopped).toBe(false); // the second run is still in flight; stop() must wait for it.

    resolveSecondRun?.();
    await stopPromise;
    expect(stopped).toBe(true);
  });
});

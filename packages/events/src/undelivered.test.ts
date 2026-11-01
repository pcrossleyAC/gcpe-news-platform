import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { createTestDatabase, dbClock, type TestDatabase } from "@gcpe/db-kit";
import { dispatchOnce } from "./dispatcher";
import { enqueueEvent } from "./publisher";
import type { SubscriberConfig } from "./subscribers";
import { sampleRelease } from "./testing";
import { dismissUndelivered, findUndelivered, listDismissed, listUndelivered, outboxHealth, retryAllUndelivered, retryUndelivered } from "./undelivered";

const migrationsFolder = fileURLToPath(new URL("../test/migrations", import.meta.url));
const HOUR = 3_600_000;

// Suite review O1.3/O2.1: any app's undelivered updates, listed, retried and counted.
describe("undelivered updates", () => {
  let tdb: TestDatabase;
  // Nothing listens on port 9: every delivery fails.
  const subs: SubscriberConfig[] = [{ name: "nod", url: "http://127.0.0.1:9/events", secret: "k", types: ["*"] }];

  beforeAll(async () => {
    tdb = await createTestDatabase({ migrationsFolder });
  });
  afterAll(async () => {
    await tdb.drop();
  });
  beforeEach(async () => {
    await tdb.pool.query("DELETE FROM outbox_events");
  });

  /** Queues one event and lets the dispatcher give up on it (its clock 25 hours on). */
  async function deadEvent(input: Parameters<typeof enqueueEvent>[1]) {
    const env = await enqueueEvent(tdb.db, input, subs);
    const later = new Date((await dbClock(tdb.db)).getTime() + 25 * HOUR);
    const silenced = console.error;
    console.error = () => {};
    try {
      await dispatchOnce({ db: tdb.db, subscribers: subs, now: () => later, timeoutMs: 2_000 });
    } finally {
      console.error = silenced;
    }
    return env;
  }

  it("lists nothing when every update was delivered", async () => {
    expect(await listUndelivered(tdb.db)).toEqual({ items: [], total: 0, replaced: 0, overtaken: 0, truncated: false });
  });

  it("lists each undelivered update with what it was about, never its payload", async () => {
    const release = await deadEvent({ type: "release.published", source: "nrms", aggregateId: "release:1", data: sampleRelease });
    await deadEvent({ type: "org.deactivated", source: "core", aggregateId: "org:health", data: { key: "health" } });
    const { items, total, truncated } = await listUndelivered(tdb.db);
    expect(total).toBe(2);
    expect(truncated).toBe(false);
    const byType = Object.fromEntries(items.map((i) => [i.type, i]));
    expect(byType["release.published"]).toMatchObject({ eventId: release.id, subscriber: "nod", aggregateId: "release:1", about: sampleRelease.documents[0]!.headline, attempts: 1 });
    expect(byType["release.published"]!.lastError).toBeTruthy();
    expect(byType["org.deactivated"]!.about).toBe("health");
    expect(JSON.stringify(items)).not.toContain(sampleRelease.summary);
  });

  it("names an activity by its number only, never its title", async () => {
    await deadEvent({ type: "activity.deleted", source: "calendar", aggregateId: "activity:12", data: { id: 12 } });
    expect((await listUndelivered(tdb.db)).items[0]!.about).toBe("Activity 12");
  });

  it("cuts the list short past its limit and still counts them all", async () => {
    for (let i = 0; i < 3; i++) await deadEvent({ type: "org.deactivated", source: "core", aggregateId: `org:o${i}`, data: { key: `o${i}` } });
    const list = await listUndelivered(tdb.db, 2);
    expect(list.items).toHaveLength(2);
    expect(list).toMatchObject({ total: 3, replaced: 0, truncated: true });
  });

  it("retries one: back to waiting, due now (behind what is already due), and not found the second time", async () => {
    const env = await deadEvent({ type: "org.deactivated", source: "core", aggregateId: "org:r", data: { key: "r" } });
    expect(await retryUndelivered(tdb.db, env.id, "nod")).toBe("queued");
    expect(await retryUndelivered(tdb.db, env.id, "nod")).toBe("not-found");
    expect(await retryUndelivered(tdb.db, env.id, "someone-else")).toBe("not-found");
    // Suite review N1: now(), not the epoch, so a retried row queues behind deliveries already due.
    const { rows } = await tdb.pool.query("SELECT status, attempts, last_error, next_attempt_at <= now() AS due, next_attempt_at > now() - interval '1 minute' AS recent FROM outbox_deliveries WHERE event_id = $1", [env.id]);
    expect(rows[0]).toEqual({ status: "pending", attempts: 0, last_error: null, due: true, recent: true });
    expect((await listUndelivered(tdb.db)).items).toEqual([]);
  });

  it("retries all of them at once", async () => {
    for (let i = 0; i < 2; i++) await deadEvent({ type: "org.deactivated", source: "core", aggregateId: `org:a${i}`, data: { key: `a${i}` } });
    expect(await retryAllUndelivered(tdb.db)).toEqual({ retried: 2, replaced: 0, overtaken: 0 });
    expect(await retryAllUndelivered(tdb.db)).toEqual({ retried: 0, replaced: 0, overtaken: 0 });
  });

  // Suite review I1 (controller ruling 2026-11-01): a published-then-unpublished release, both
  // undelivered to NoD. Resending the "published" one would email a withdrawn release.
  describe("an update a newer one for the same record replaced", () => {
    async function publishedThenUnpublished() {
      const published = await deadEvent({ type: "release.published", source: "nrms", aggregateId: "release:9", data: sampleRelease });
      const unpublished = await deadEvent({ type: "release.unpublished", source: "nrms", aggregateId: "release:9", data: { key: sampleRelease.key } });
      return { published, unpublished };
    }
    const statusOf = async (id: string) => (await tdb.pool.query("SELECT status FROM outbox_deliveries WHERE event_id = $1", [id])).rows[0]?.status;

    it("is listed as replaced, and the newest one is not", async () => {
      const { published, unpublished } = await publishedThenUnpublished();
      const list = await listUndelivered(tdb.db);
      expect(list.items.find((i) => i.eventId === published.id)!.replaced).toBe(true);
      expect(list.items.find((i) => i.eventId === unpublished.id)!.replaced).toBe(false);
      expect(list).toMatchObject({ total: 2, replaced: 1 });
    });

    it("is refused on its own and stays undelivered", async () => {
      const { published } = await publishedThenUnpublished();
      expect(await retryUndelivered(tdb.db, published.id, "nod")).toBe("replaced");
      expect(await statusOf(published.id)).toBe("dead");
    });

    it("is skipped by Retry all, which resends only the newest", async () => {
      const { published, unpublished } = await publishedThenUnpublished();
      expect(await retryAllUndelivered(tdb.db)).toEqual({ retried: 1, replaced: 1, overtaken: 0 });
      expect(await statusOf(published.id)).toBe("dead");
      expect(await statusOf(unpublished.id)).toBe("pending");
    });

    it("counts as replaced when the newer one was delivered, but not when it went to another app", async () => {
      const older = await deadEvent({ type: "org.deactivated", source: "core", aggregateId: "org:n", data: { key: "n" } });
      const newer = await enqueueEvent(tdb.db, { type: "org.deactivated", source: "core", aggregateId: "org:n", data: { key: "n" } }, subs);
      await tdb.pool.query("UPDATE outbox_deliveries SET status = 'delivered' WHERE event_id = $1", [newer.id]);
      expect(await retryUndelivered(tdb.db, older.id, "nod")).toBe("replaced");
      await tdb.pool.query("UPDATE outbox_deliveries SET subscriber = 'calendar' WHERE event_id = $1", [newer.id]);
      expect(await retryUndelivered(tdb.db, older.id, "nod")).toBe("queued");
    });

    it("is left out of the health count", async () => {
      await publishedThenUnpublished();
      expect(await outboxHealth(tdb.db, { recentMs: 7 * 24 * HOUR })).toMatchObject({ undelivered: 1, replaced: 1, recentUndelivered: 1 });
    });
  });

  // Fix round 2, M4: a newer update that can't stand in for the older one doesn't replace it.
  describe("a newer update that can't stand in for it", () => {
    const statusOf = async (id: string) => (await tdb.pool.query("SELECT status FROM outbox_deliveries WHERE event_id = $1", [id])).rows[0]?.status;
    async function publishedThenUpdated(updatedStatus: "delivered" | "dead") {
      const published = await deadEvent({ type: "release.published", source: "nrms", aggregateId: "release:7", data: sampleRelease });
      const updated = await enqueueEvent(tdb.db, { type: "release.updated", source: "nrms", aggregateId: "release:7", data: { ...sampleRelease, notify: false } }, subs);
      await tdb.pool.query("UPDATE outbox_deliveries SET status = $2 WHERE event_id = $1", [updated.id, updatedStatus]);
      return { published, updated };
    }

    it("published undelivered, correction delivered: not replaced, overtaken, still alerting, and Retry is refused", async () => {
      const { published } = await publishedThenUpdated("delivered");
      const item = (await listUndelivered(tdb.db)).items.find((i) => i.eventId === published.id)!;
      expect(item).toMatchObject({ replaced: false, overtaken: true });
      expect(await outboxHealth(tdb.db, { recentMs: 7 * 24 * HOUR })).toMatchObject({ undelivered: 1, replaced: 0, recentUndelivered: 1 });
      expect(await retryUndelivered(tdb.db, published.id, "nod")).toBe("overtaken");
      expect(await retryAllUndelivered(tdb.db)).toEqual({ retried: 0, replaced: 0, overtaken: 1 });
      expect(await statusOf(published.id)).toBe("dead");
    });

    it("published and correction both undelivered: neither replaced nor overtaken, so the publish can be retried", async () => {
      const { published } = await publishedThenUpdated("dead");
      expect((await listUndelivered(tdb.db)).items.find((i) => i.eventId === published.id)).toMatchObject({ replaced: false, overtaken: false });
      expect(await retryUndelivered(tdb.db, published.id, "nod")).toBe("queued");
    });
  });

  // Fix round 3, M5.
  describe("an update a newer one can't fully stand in for", () => {
    const emailAgain = { seq: 1, subscribers: true, mediaLists: false, requestedBy: "Pat Editor", requestedAt: "2026-10-31T10:00:00-07:00" };

    it("a correction asking to email it again is not replaced by a later plain correction, and keeps alerting", async () => {
      const asked = await deadEvent({ type: "release.updated", source: "nrms", aggregateId: "release:ea", data: { ...sampleRelease, notify: true, emailAgain } });
      const plain = await enqueueEvent(tdb.db, { type: "release.updated", source: "nrms", aggregateId: "release:ea", data: { ...sampleRelease, notify: false } }, subs);
      await tdb.pool.query("UPDATE outbox_deliveries SET status = 'delivered' WHERE event_id = $1", [plain.id]);
      const item = (await listUndelivered(tdb.db)).items.find((i) => i.eventId === asked.id)!;
      expect(item.replaced).toBe(false);
      expect(await outboxHealth(tdb.db, { recentMs: 7 * 24 * HOUR })).toMatchObject({ undelivered: 1, replaced: 0, recentUndelivered: 1 });
    });

    it("a correction asking to email it again is replaced by the release's unpublish", async () => {
      const asked = await deadEvent({ type: "release.updated", source: "nrms", aggregateId: "release:eb", data: { ...sampleRelease, notify: true, emailAgain } });
      await deadEvent({ type: "release.unpublished", source: "nrms", aggregateId: "release:eb", data: { key: sampleRelease.key } });
      expect((await listUndelivered(tdb.db)).items.find((i) => i.eventId === asked.id)!.replaced).toBe(true);
    });

    it("a rename then a deactivation, both undelivered: the rename isn't replaced, and Retry all resends both", async () => {
      const renamed = await deadEvent({ type: "media_list.updated", source: "nrms", aggregateId: "media_list:radio", data: { key: "radio", displayName: "Radio (new)", sortOrder: 1, isActive: true } });
      const deactivated = await deadEvent({ type: "media_list.deactivated", source: "nrms", aggregateId: "media_list:radio", data: { key: "radio" } });
      expect((await listUndelivered(tdb.db)).items.find((i) => i.eventId === renamed.id)!.replaced).toBe(false);
      expect(await retryAllUndelivered(tdb.db)).toEqual({ retried: 2, replaced: 0, overtaken: 0 });
      expect(deactivated.sequence).toBeGreaterThan(renamed.sequence);
    });
  });

  // Suite review M1: an update an administrator decided not to send.
  describe("dismissing", () => {
    it("takes one off the list and out of health, onto the dismissed list, and it can't be retried", async () => {
      const env = await deadEvent({ type: "org.deactivated", source: "core", aggregateId: "org:x1", data: { key: "x1" } });
      const found = await findUndelivered(tdb.db, env.id, "nod");
      expect(found).toMatchObject({ eventId: env.id, subscriber: "nod", type: "org.deactivated", about: "x1" });
      expect(await dismissUndelivered(tdb.db, [found!])).toMatchObject([{ eventId: env.id }]);
      expect(await dismissUndelivered(tdb.db, [found!])).toEqual([]);
      expect(await findUndelivered(tdb.db, env.id, "nod")).toBeNull();
      expect((await listUndelivered(tdb.db)).items).toEqual([]);
      expect((await listDismissed(tdb.db)).items.map((i) => i.eventId)).toEqual([env.id]);
      expect(await retryUndelivered(tdb.db, env.id, "nod")).toBe("not-found");
      expect(await outboxHealth(tdb.db, { recentMs: 7 * 24 * HOUR })).toMatchObject({ undelivered: 0, recentUndelivered: 0 });
    });

    it("dismisses several at once, replaced ones included, and only those named", async () => {
      const a = await deadEvent({ type: "org.deactivated", source: "core", aggregateId: "org:x2", data: { key: "x2" } });
      const b = await deadEvent({ type: "org.deactivated", source: "core", aggregateId: "org:x2", data: { key: "x2" } });
      const c = await deadEvent({ type: "org.deactivated", source: "core", aggregateId: "org:x3", data: { key: "x3" } });
      const done = await dismissUndelivered(tdb.db, [a, b].map((e) => ({ eventId: e.id, subscriber: "nod" })));
      expect(done.map((d) => d.eventId).sort()).toEqual([a.id, b.id].sort());
      expect((await listUndelivered(tdb.db)).items.map((i) => i.eventId)).toEqual([c.id]);
    });
  });

  it("counts the backlog: waiting, the oldest wait and undelivered (recent and all)", async () => {
    const empty = await outboxHealth(tdb.db, { recentMs: 7 * 24 * HOUR });
    expect(empty).toEqual({ pending: 0, oldestPendingMinutes: null, undelivered: 0, replaced: 0, recentUndelivered: 0 });

    await deadEvent({ type: "org.deactivated", source: "core", aggregateId: "org:d", data: { key: "d" } });
    await enqueueEvent(tdb.db, { type: "org.deactivated", source: "core", aggregateId: "org:p", data: { key: "p" } }, subs);
    const now = await dbClock(tdb.db);
    const h = await outboxHealth(tdb.db, { recentMs: 7 * 24 * HOUR, now: () => new Date(now.getTime() + 90 * 60_000) });
    expect(h).toEqual({ pending: 1, oldestPendingMinutes: 90, undelivered: 1, replaced: 0, recentUndelivered: 1 });
    // Eight days on, the undelivered one is no longer recent, but still counted.
    const old = await outboxHealth(tdb.db, { recentMs: 7 * 24 * HOUR, now: () => new Date(now.getTime() + 8 * 24 * HOUR) });
    expect(old).toMatchObject({ undelivered: 1, recentUndelivered: 0 });
  });

  // Fix round 2, I2: the replaced check reads newer events through the index, not a table scan.
  it("finds newer events for a record through the (aggregate_id, sequence) index", async () => {
    await tdb.pool.query("INSERT INTO outbox_events (id, type, aggregate_id, sequence, envelope) SELECT gen_random_uuid(), 'org.deactivated', 'org:bulk' || g, 1, '{}'::jsonb FROM generate_series(1, 20000) g");
    await deadEvent({ type: "org.deactivated", source: "core", aggregateId: "org:probe", data: { key: "probe" } });
    await tdb.pool.query("ANALYZE outbox_events");
    const plan = (await tdb.pool.query("EXPLAIN SELECT * FROM outbox_deliveries d JOIN outbox_events e ON e.id = d.event_id WHERE d.status = 'dead' AND EXISTS (SELECT 1 FROM outbox_deliveries d2 JOIN outbox_events e2 ON e2.id = d2.event_id WHERE d2.subscriber = d.subscriber AND e2.aggregate_id = e.aggregate_id AND e2.sequence > e.sequence)")).rows.map((r) => r["QUERY PLAN"]).join("\n");
    expect(plan).toContain("outbox_events_aggregate_seq_idx");
  });

  // Fix round 3, M6: a retried update goes out before a newer one for the same record that is
  // already waiting, or the receiver would apply the newer one first and drop the retried one as stale.
  describe("a retried update and a newer one already waiting", () => {
    let server: Server;
    let received: string[] = [];
    let live: SubscriberConfig[];
    beforeAll(async () => {
      server = createServer((req, res) => {
        received.push(String(req.headers["x-event-id"]));
        req.resume();
        req.on("end", () => res.end());
      });
      await new Promise<void>((r) => server.listen(0, r));
      live = [{ name: "nod", url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/events`, secret: "k", types: ["*"] }];
    });
    afterAll(() => {
      server.close();
    });

    async function publishDeadUpdateWaiting() {
      received = [];
      const published = await enqueueEvent(tdb.db, { type: "release.published", source: "nrms", aggregateId: "release:m6", data: sampleRelease }, live);
      const updated = await enqueueEvent(tdb.db, { type: "release.updated", source: "nrms", aggregateId: "release:m6", data: { ...sampleRelease, notify: false } }, live);
      await tdb.pool.query("UPDATE outbox_deliveries SET status = 'dead', attempts = 9, last_error = 'HTTP 503' WHERE event_id = $1", [published.id]);
      // The correction is in backoff and already due again.
      await tdb.pool.query("UPDATE outbox_deliveries SET attempts = 3, next_attempt_at = now() - interval '1 minute' WHERE event_id = $1", [updated.id]);
      return { published, updated };
    }

    it("Retry sends the older one first", async () => {
      const { published, updated } = await publishDeadUpdateWaiting();
      expect(await retryUndelivered(tdb.db, published.id, "nod")).toBe("queued");
      expect(await dispatchOnce({ db: tdb.db, subscribers: live })).toEqual({ delivered: 2, retried: 0, dead: 0 });
      expect(received).toEqual([published.id, updated.id]);
    });

    it("Retry all sends the older one first too", async () => {
      const { published, updated } = await publishDeadUpdateWaiting();
      expect(await retryAllUndelivered(tdb.db)).toMatchObject({ retried: 1 });
      await dispatchOnce({ db: tdb.db, subscribers: live });
      expect(received).toEqual([published.id, updated.id]);
    });
  });
});

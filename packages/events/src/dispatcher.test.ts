import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { eq } from "drizzle-orm";
import { createTestDatabase, type TestDatabase } from "@gcpe/db-kit";
import { backoffMs, dispatchOnce } from "./dispatcher";
import { enqueueEvent } from "./publisher";
import { verifySignature } from "./signing";
import type { SubscriberConfig } from "./subscribers";
import { outboxDeliveries } from "./tables";

const migrationsFolder = new URL("../test/migrations", import.meta.url).pathname;

describe("dispatchOnce", () => {
  let tdb: TestDatabase;
  let server: Server;
  let received: { headers: Record<string, string | string[] | undefined>; body: string }[] = [];
  let respondWith = 200;
  let respondDelayMs = 0;
  let subs: SubscriberConfig[];

  beforeAll(async () => {
    tdb = await createTestDatabase({ migrationsFolder });
    server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        received.push({ headers: req.headers, body });
        const send = () => {
          res.statusCode = respondWith;
          res.end();
        };
        if (respondDelayMs > 0) setTimeout(send, respondDelayMs);
        else send();
      });
    });
    await new Promise<void>((r) => server.listen(0, r));
    const port = (server.address() as AddressInfo).port;
    subs = [{ name: "target", url: `http://127.0.0.1:${port}/events`, secret: "k", types: ["*"] }];
  });
  afterAll(async () => {
    server.close();
    await tdb.drop();
  });
  beforeEach(async () => {
    received = [];
    respondWith = 200;
    respondDelayMs = 0;
    await tdb.pool.query("DELETE FROM outbox_events");
  });

  it("delivers a signed event and marks it delivered", async () => {
    const env = await enqueueEvent(tdb.db, { type: "org.deactivated", source: "core", aggregateId: "org:x", data: { key: "x" } }, subs);
    expect(await dispatchOnce({ db: tdb.db, subscribers: subs })).toEqual({ delivered: 1, retried: 0, dead: 0 });
    expect(received).toHaveLength(1);
    const h = received[0]!.headers;
    expect(h["x-event-id"]).toBe(env.id);
    expect(
      verifySignature({ secret: "k", timestamp: h["x-event-timestamp"] as string, body: received[0]!.body, signature: h["x-signature"] as string, nowMs: Date.now() }),
    ).toBe(true);
    const [d] = await tdb.db.select().from(outboxDeliveries).where(eq(outboxDeliveries.eventId, env.id));
    expect(d!.status).toBe("delivered");
    expect(await dispatchOnce({ db: tdb.db, subscribers: subs })).toEqual({ delivered: 0, retried: 0, dead: 0 });
  });

  it("schedules a retry with backoff on failure", async () => {
    respondWith = 503;
    const env = await enqueueEvent(tdb.db, { type: "org.deactivated", source: "core", aggregateId: "org:y", data: { key: "y" } }, subs);
    const now = new Date();
    expect(await dispatchOnce({ db: tdb.db, subscribers: subs, now: () => now })).toEqual({ delivered: 0, retried: 1, dead: 0 });
    const [d] = await tdb.db.select().from(outboxDeliveries).where(eq(outboxDeliveries.eventId, env.id));
    expect(d!.status).toBe("pending");
    expect(d!.attempts).toBe(1);
    expect(d!.nextAttemptAt.getTime()).toBe(now.getTime() + backoffMs(1));
    expect(d!.lastError).toMatch(/503/);
  });

  it("dead-letters deliveries older than maxAge", async () => {
    respondWith = 500;
    await enqueueEvent(tdb.db, { type: "org.deactivated", source: "core", aggregateId: "org:z", data: { key: "z" } }, subs);
    const later = new Date(Date.now() + 25 * 3_600_000);
    expect(await dispatchOnce({ db: tdb.db, subscribers: subs, now: () => later })).toEqual({ delivered: 0, retried: 0, dead: 1 });
  });

  it("concurrent dispatchOnce calls deliver each event once", async () => {
    for (let i = 0; i < 10; i++) {
      await enqueueEvent(tdb.db, { type: "org.deactivated", source: "core", aggregateId: `org:c${i}`, data: { key: `c${i}` } }, subs);
    }
    const results = await Promise.all([
      dispatchOnce({ db: tdb.db, subscribers: subs }),
      dispatchOnce({ db: tdb.db, subscribers: subs }),
      dispatchOnce({ db: tdb.db, subscribers: subs }),
    ]);
    expect(results.reduce((n, r) => n + r.delivered, 0)).toBe(10);
    expect(new Set(received.map((r) => r.headers["x-event-id"])).size).toBe(10);
    expect(received).toHaveLength(10);
  });

  it("does not overwrite a row whose lock was stolen by another replica mid-delivery", async () => {
    respondDelayMs = 300;
    const env = await enqueueEvent(tdb.db, { type: "org.deactivated", source: "core", aggregateId: "org:stolen", data: { key: "s" } }, subs);

    const dispatchPromise = dispatchOnce({ db: tdb.db, subscribers: subs, timeoutMs: 5_000 });
    // Give the claim UPDATE + outgoing fetch time to happen before we steal the lock.
    await new Promise((r) => setTimeout(r, 100));
    const stolenLock = new Date(Date.now() + 999_000);
    await tdb.pool.query("UPDATE outbox_deliveries SET locked_until = $1 WHERE event_id = $2", [stolenLock, env.id]);

    const result = await dispatchPromise;
    expect(result).toEqual({ delivered: 0, retried: 0, dead: 0 });
    expect(received).toHaveLength(1); // the HTTP request still went out

    const [d] = await tdb.db.select().from(outboxDeliveries).where(eq(outboxDeliveries.eventId, env.id));
    expect(d!.status).toBe("pending");
    expect(d!.attempts).toBe(0);
    expect(d!.lastError).toBeNull();
    expect(d!.lockedUntil?.getTime()).toBe(stolenLock.getTime());
  });

  it("retries an unconfigured subscriber like any other failure, then dead-letters past maxAge", async () => {
    const ghost: SubscriberConfig = { name: "ghost", url: "http://127.0.0.1:1/events", secret: "k", types: ["*"] };
    const env = await enqueueEvent(tdb.db, { type: "org.deactivated", source: "core", aggregateId: "org:ghost", data: { key: "g" } }, [ghost]);

    const now = new Date();
    expect(await dispatchOnce({ db: tdb.db, subscribers: [], now: () => now })).toEqual({ delivered: 0, retried: 1, dead: 0 });
    const [d] = await tdb.db.select().from(outboxDeliveries).where(eq(outboxDeliveries.eventId, env.id));
    expect(d!.status).toBe("pending");
    expect(d!.attempts).toBe(1);
    expect(d!.nextAttemptAt.getTime()).toBe(now.getTime() + backoffMs(1));
    expect(d!.lastError).toMatch(/not configured/);

    const later = new Date(now.getTime() + 25 * 3_600_000);
    expect(await dispatchOnce({ db: tdb.db, subscribers: [], now: () => later })).toEqual({ delivered: 0, retried: 0, dead: 1 });
  });

  it("computes capped exponential backoff", () => {
    expect(backoffMs(1)).toBe(10_000);
    expect(backoffMs(2)).toBe(20_000);
    expect(backoffMs(20)).toBe(3_600_000);
  });
});

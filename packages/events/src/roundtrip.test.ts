import { afterAll, beforeAll, describe, expect, it } from "vitest";
import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { sql } from "drizzle-orm";
import { createTestDatabase, type TestDatabase } from "@gcpe/db-kit";
import { dispatchOnce } from "./dispatcher";
import { enqueueEvent } from "./publisher";
import { createEventReceiver } from "./receiver";
import type { SubscriberConfig } from "./subscribers";
import { fileURLToPath } from "node:url";

const migrationsFolder = fileURLToPath(new URL("../test/migrations", import.meta.url));

describe("producer → consumer round trip", () => {
  let producer: TestDatabase;
  let consumer: TestDatabase;
  let server: Server;
  let subs: SubscriberConfig[];
  // The consumer listens from the start (port 0, no find-then-relisten race) and simulates
  // being down by answering 503 until this flag is cleared.
  let down = true;
  const outcomes: unknown[] = [];

  // Records each response body the consumer sent back, so the test can see the receiver's outcome.
  const recordingFetch: typeof fetch = async (input, init) => {
    const res = await fetch(input, init);
    outcomes.push(res.ok ? await res.clone().json() : res.status);
    return res;
  };

  beforeAll(async () => {
    producer = await createTestDatabase({ migrationsFolder });
    consumer = await createTestDatabase({ migrationsFolder });
    await consumer.pool.query("CREATE TABLE deactivated (key text PRIMARY KEY)");
    const app = express();
    app.use((_req, res, next) => (down ? void res.status(503).end() : next()));
    app.use(
      createEventReceiver({
        db: consumer.db,
        secrets: { core: "shared" },
        handlers: {
          "org.deactivated": async (tx, e) => {
            await tx.execute(sql`INSERT INTO deactivated (key) VALUES (${(e.data as { key: string }).key})`);
          },
        },
      }),
    );
    server = await new Promise<Server>((r) => {
      const s = app.listen(0, () => r(s));
    });
    const port = (server.address() as AddressInfo).port;
    subs = [{ name: "consumer", url: `http://127.0.0.1:${port}/events`, secret: "shared", types: ["org.deactivated"] }];
  });
  afterAll(async () => {
    await new Promise((r) => server.close(r));
    await producer.drop();
    await consumer.drop();
  });

  it("retries while the consumer is down, delivers exactly once, and dedupes a redelivery", async () => {
    const env = await enqueueEvent(producer.db, { type: "org.deactivated", source: "core", aggregateId: "org:health", data: { key: "health" } }, subs);

    const whileDown = await dispatchOnce({ db: producer.db, subscribers: subs, fetchImpl: recordingFetch });
    expect(whileDown.retried).toBe(1);
    expect(outcomes).toEqual([503]);

    down = false;
    const later = new Date(Date.now() + 11_000);
    const up = await dispatchOnce({ db: producer.db, subscribers: subs, now: () => later, fetchImpl: recordingFetch });
    expect(up.delivered).toBe(1);
    expect(outcomes.at(-1)).toEqual({ outcome: "applied" });

    // Simulate an at-least-once redelivery (e.g. the producer crashed before recording success).
    await producer.pool.query(
      "UPDATE outbox_deliveries SET status = 'pending', next_attempt_at = now() - interval '1 second', locked_until = NULL WHERE event_id = $1",
      [env.id],
    );
    const again = await dispatchOnce({ db: producer.db, subscribers: subs, fetchImpl: recordingFetch });
    expect(again.delivered).toBe(1);
    expect(outcomes.at(-1)).toEqual({ outcome: "duplicate" });

    const { rows } = await consumer.pool.query("SELECT key FROM deactivated");
    expect(rows).toEqual([{ key: "health" }]);
    const inbox = await consumer.pool.query("SELECT outcome FROM inbox_events WHERE event_id = $1", [env.id]);
    expect(inbox.rows).toEqual([{ outcome: "applied" }]);
  });
});

describe("same-aggregate events written in one transaction", () => {
  let producer: TestDatabase;
  let consumer: TestDatabase;
  let server: Server;
  const arrivals: { subscriber: string; sequence: number; outcome: unknown }[] = [];

  beforeAll(async () => {
    producer = await createTestDatabase({ migrationsFolder });
    consumer = await createTestDatabase({ migrationsFolder });
    await consumer.pool.query("CREATE TABLE applied (seq integer PRIMARY KEY)");
    const app = express();
    app.use(
      createEventReceiver({
        db: consumer.db,
        secrets: { core: "shared" },
        handlers: {
          "org.deactivated": async (tx, e) => void (await tx.execute(sql`INSERT INTO applied (seq) VALUES (${e.sequence})`)),
        },
      }),
    );
    server = await new Promise<Server>((r) => {
      const s = app.listen(0, () => r(s));
    });
  });
  afterAll(async () => {
    await new Promise((r) => server.close(r));
    await producer.drop();
    await consumer.drop();
  });

  it("reach every subscriber in sequence order, so the real receiver applies all of them", async () => {
    const port = (server.address() as AddressInfo).port;
    const real = `http://127.0.0.1:${port}/events`;
    // One real receiver plus recording-only subscribers: the claim must order each subscriber's rows.
    const subs: SubscriberConfig[] = ["consumer", "other-a", "other-b"].map((name) => ({
      name,
      url: name === "consumer" ? real : `http://recorder.invalid/${name}`,
      secret: "shared",
      types: ["*"],
    }));
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      const sub = subs.find((s) => s.url === url)!;
      const sequence = (JSON.parse(String(init!.body)) as { sequence: number }).sequence;
      if (url !== real) {
        arrivals.push({ subscriber: sub.name, sequence, outcome: "recorded" });
        return new Response(null, { status: 200 });
      }
      const res = await fetch(input, init);
      arrivals.push({ subscriber: sub.name, sequence, outcome: res.ok ? ((await res.clone().json()) as { outcome: string }).outcome : res.status });
      return res;
    };

    // Delivered history makes the planner pick a hash semi-join for the claim, whose output
    // order is unrelated to write order (the reviewer's C1 probe).
    await producer.pool.query(`
      INSERT INTO outbox_events (id, type, aggregate_id, sequence, envelope)
        SELECT gen_random_uuid(), 'org.upserted', 'org:old-' || g, 1, '{}'::jsonb FROM generate_series(1, 5000) g;
      INSERT INTO outbox_deliveries (event_id, subscriber, status)
        SELECT id, 'consumer', 'delivered' FROM outbox_events;
      ANALYZE outbox_events; ANALYZE outbox_deliveries;`);

    await producer.db.transaction(async (tx) => {
      await enqueueEvent(tx, { type: "org.deactivated", source: "core", aggregateId: "org:a", data: { key: "a" } }, subs);
      await enqueueEvent(tx, { type: "org.deactivated", source: "core", aggregateId: "org:a", data: { key: "a" } }, subs);
      await enqueueEvent(tx, { type: "org.deactivated", source: "core", aggregateId: "org:a", data: { key: "a" } }, subs);
    });

    const result = await dispatchOnce({ db: producer.db, subscribers: subs, fetchImpl });
    expect(result.delivered).toBe(9);
    for (const name of ["consumer", "other-a", "other-b"]) {
      expect(arrivals.filter((a) => a.subscriber === name).map((a) => a.sequence)).toEqual([1, 2, 3]);
    }
    expect(arrivals.filter((a) => a.subscriber === "consumer").map((a) => a.outcome)).toEqual(["applied", "applied", "applied"]);
    const { rows } = await consumer.pool.query("SELECT seq FROM applied ORDER BY seq");
    expect(rows).toEqual([{ seq: 1 }, { seq: 2 }, { seq: 3 }]);
  });
});

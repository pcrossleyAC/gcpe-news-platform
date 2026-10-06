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

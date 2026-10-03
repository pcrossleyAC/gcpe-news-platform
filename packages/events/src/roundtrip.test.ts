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

const migrationsFolder = new URL("../test/migrations", import.meta.url).pathname;

describe("producer → consumer round trip", () => {
  let producer: TestDatabase;
  let consumer: TestDatabase;
  let server: Server | undefined;
  let subs: SubscriberConfig[];
  let port: number;

  function startConsumer(): Promise<void> {
    const app = express();
    app.use(
      createEventReceiver({
        db: consumer.db,
        secrets: { core: "shared" },
        handlers: {
          "org.deactivated": async (tx, e) => {
            await tx.execute(sql`INSERT INTO deactivated (key) VALUES (${(e.data as { key: string }).key}) ON CONFLICT DO NOTHING`);
          },
        },
      }),
    );
    return new Promise((r) => {
      server = app.listen(port, () => r());
    });
  }

  beforeAll(async () => {
    producer = await createTestDatabase({ migrationsFolder });
    consumer = await createTestDatabase({ migrationsFolder });
    await consumer.pool.query("CREATE TABLE deactivated (key text PRIMARY KEY)");
    const probe = await new Promise<Server>((r) => {
      const s = express().listen(0, () => r(s));
    });
    port = (probe.address() as AddressInfo).port;
    await new Promise((r) => probe.close(r));
    subs = [{ name: "consumer", url: `http://127.0.0.1:${port}/events`, secret: "shared", types: ["org.deactivated"] }];
  });
  afterAll(async () => {
    server?.close();
    await producer.drop();
    await consumer.drop();
  });

  it("retries while the consumer is down, then delivers exactly once", async () => {
    await enqueueEvent(producer.db, { type: "org.deactivated", source: "core", aggregateId: "org:health", data: { key: "health" } }, subs);

    const down = await dispatchOnce({ db: producer.db, subscribers: subs });
    expect(down.retried).toBe(1);

    await startConsumer();
    const later = new Date(Date.now() + 11_000);
    const up = await dispatchOnce({ db: producer.db, subscribers: subs, now: () => later });
    expect(up.delivered).toBe(1);

    const { rows } = await consumer.pool.query("SELECT key FROM deactivated");
    expect(rows).toEqual([{ key: "health" }]);
  });
});

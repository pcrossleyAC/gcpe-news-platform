import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDatabase, type TestDatabase } from "@gcpe/db-kit";
import { enqueueEvent } from "./publisher";
import { parseSubscribers } from "./subscribers";
import { outboxDeliveries, outboxEvents } from "./tables";

const migrationsFolder = new URL("../test/migrations", import.meta.url).pathname;
const subs = parseSubscribers(
  JSON.stringify([
    { name: "news-api", url: "http://news-api/events", secret: "a", types: ["org.upserted"] },
    { name: "audit", url: "http://audit/events", secret: "b", types: ["*"] },
  ]),
);

describe("enqueueEvent", () => {
  let tdb: TestDatabase;
  beforeAll(async () => {
    tdb = await createTestDatabase({ migrationsFolder });
  });
  afterAll(async () => {
    await tdb.drop();
  });

  it("assigns increasing sequences per aggregate and fans out to matching subscribers", async () => {
    const first = await enqueueEvent(tdb.db, { type: "org.deactivated", source: "core", aggregateId: "org:a", data: { key: "a" } }, subs);
    const second = await enqueueEvent(tdb.db, { type: "org.deactivated", source: "core", aggregateId: "org:a", data: { key: "a" } }, subs);
    const other = await enqueueEvent(tdb.db, { type: "org.deactivated", source: "core", aggregateId: "org:b", data: { key: "b" } }, subs);
    expect([first.sequence, second.sequence, other.sequence]).toEqual([1, 2, 1]);

    const deliveries = await tdb.db.select().from(outboxDeliveries).where(eq(outboxDeliveries.eventId, first.id));
    expect(deliveries.map((d) => d.subscriber)).toEqual(["audit"]);
  });

  it("stores the full envelope", async () => {
    const env = await enqueueEvent(tdb.db, { type: "org.deactivated", source: "core", aggregateId: "org:c", data: { key: "c" } }, subs);
    const [row] = await tdb.db.select().from(outboxEvents).where(eq(outboxEvents.id, env.id));
    expect(row!.envelope).toEqual(env);
  });

  it("rejects data that does not match the catalogue and writes nothing", async () => {
    await expect(
      tdb.db.transaction((tx) => enqueueEvent(tx, { type: "org.deactivated", source: "core", aggregateId: "org:d", data: {} }, subs)),
    ).rejects.toThrow();
    const rows = await tdb.db.select().from(outboxEvents).where(eq(outboxEvents.aggregateId, "org:d"));
    expect(rows).toHaveLength(0);
  });
});

describe("parseSubscribers", () => {
  it("returns [] for undefined and rejects malformed config", () => {
    expect(parseSubscribers(undefined)).toEqual([]);
    expect(() => parseSubscribers('[{"name":"x"}]')).toThrow();
  });
});

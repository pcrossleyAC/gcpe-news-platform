import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { createTestDatabase, type TestDatabase } from "@gcpe/db-kit";
import { createEventReceiver } from "./receiver";
import { signPayload } from "./signing";

const migrationsFolder = new URL("../test/migrations", import.meta.url).pathname;

function makeEvent(seq: number, aggregateId = "org:health", type = "org.deactivated") {
  return { id: randomUUID(), type, version: 1, source: "core", aggregateId, sequence: seq, occurredAt: new Date().toISOString(), correlationId: randomUUID(), data: { key: "health" } };
}

function post(app: express.Express, event: object, opts: { secret?: string; timestamp?: string } = {}) {
  const body = JSON.stringify(event);
  const ts = opts.timestamp ?? new Date().toISOString();
  return request(app)
    .post("/events")
    .set("content-type", "application/json")
    .set("x-event-source", "core")
    .set("x-event-timestamp", ts)
    .set("x-signature", signPayload(opts.secret ?? "k", ts, body))
    .send(body);
}

describe("createEventReceiver", () => {
  let tdb: TestDatabase;
  let app: express.Express;
  let applied: string[] = [];
  let failNext = false;

  beforeAll(async () => {
    tdb = await createTestDatabase({ migrationsFolder });
    await tdb.pool.query("CREATE TABLE side_effects (event_id uuid PRIMARY KEY)");
    app = express();
    app.use(
      createEventReceiver({
        db: tdb.db,
        secrets: { core: "k" },
        handlers: {
          "org.deactivated": async (tx, event) => {
            await tx.execute(sql`INSERT INTO side_effects (event_id) VALUES (${event.id})`);
            if (failNext) {
              failNext = false;
              throw new Error("boom");
            }
            applied.push(event.id);
          },
        },
      }),
    );
  });
  afterAll(async () => {
    await tdb.drop();
  });
  beforeEach(() => {
    applied = [];
  });

  it("applies a valid event once and reports duplicates", async () => {
    const e = makeEvent(1);
    expect((await post(app, e)).body).toEqual({ outcome: "applied" });
    expect((await post(app, e)).body).toEqual({ outcome: "duplicate" });
    expect(applied).toEqual([e.id]);
  });

  it("rejects bad signatures and stale timestamps with 401", async () => {
    expect((await post(app, makeEvent(2), { secret: "wrong" })).status).toBe(401);
    expect((await post(app, makeEvent(2), { timestamp: new Date(Date.now() - 600_000).toISOString() })).status).toBe(401);
  });

  it("rejects an invalid event with 400", async () => {
    expect((await post(app, { ...makeEvent(3), data: {} })).status).toBe(400);
  });

  it("stale sequence is ignored", async () => {
    const newer = makeEvent(10, "org:seq");
    const older = makeEvent(9, "org:seq");
    expect((await post(app, newer)).body.outcome).toBe("applied");
    expect((await post(app, older)).body.outcome).toBe("stale");
    expect(applied).toEqual([newer.id]);
  });

  it("handler throws → 500 and event is re-appliable", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const e = makeEvent(1, "org:fail");
      failNext = true;
      expect((await post(app, e)).status).toBe(500);
      const side = await tdb.pool.query("SELECT 1 FROM side_effects WHERE event_id = $1", [e.id]);
      expect(side.rowCount).toBe(0);
      expect((await post(app, e)).body.outcome).toBe("applied");
    } finally {
      errSpy.mockRestore();
    }
  });

  it("records events with no handler as ignored", async () => {
    expect((await post(app, makeEvent(1, "x:1", "future.thing"))).body).toEqual({ outcome: "ignored" });
  });
});

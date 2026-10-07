import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { createTestDatabase, type TestDatabase } from "@gcpe/db-kit";
import { MAX_EVENT_BYTES } from "./envelope";
import { createEventReceiver } from "./receiver";
import { signPayload } from "./signing";
import { fileURLToPath } from "node:url";

const migrationsFolder = fileURLToPath(new URL("../test/migrations", import.meta.url));

function makeEvent(seq: number, aggregateId = "org:health", type = "org.deactivated") {
  return { id: randomUUID(), type, version: 1, source: "core", aggregateId, sequence: seq, occurredAt: new Date().toISOString(), correlationId: randomUUID(), data: { key: "health" } };
}

function post(app: express.Express, event: object, opts: { secret?: string; timestamp?: string; source?: string } = {}) {
  const body = JSON.stringify(event);
  const ts = opts.timestamp ?? new Date().toISOString();
  return request(app)
    .post("/events")
    .set("content-type", "application/json")
    .set("x-event-source", opts.source ?? "core")
    .set("x-event-timestamp", ts)
    .set("x-signature", signPayload(opts.secret ?? "k", ts, body))
    .send(body);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

describe("createEventReceiver", () => {
  let tdb: TestDatabase;
  let app: express.Express;
  let applied: string[] = [];
  let failNext = false;
  let raceOrder: number[] = [];
  let onAppliedCalls: string[] = [];
  let onAppliedShouldThrow = false;

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
            if (event.aggregateId === "org:race") {
              await sleep(300);
              await tx.execute(sql`INSERT INTO side_effects (event_id) VALUES (${event.id})`);
              raceOrder.push(event.sequence);
              return;
            }
            await tx.execute(sql`INSERT INTO side_effects (event_id) VALUES (${event.id})`);
            if (failNext) {
              failNext = false;
              throw new Error("boom");
            }
            applied.push(event.id);
          },
        },
        onApplied: async (event) => {
          onAppliedCalls.push(event.id);
          if (onAppliedShouldThrow) throw new Error("onApplied boom for someone@example.test");
        },
      }),
    );
  });
  afterAll(async () => {
    await tdb.drop();
  });
  beforeEach(() => {
    applied = [];
    raceOrder = [];
    onAppliedCalls = [];
    onAppliedShouldThrow = false;
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
      // The failure can be in the inbox bookkeeping as well as the handler itself -- the
      // handler here (a lockAddress/findSubscriberForUpdate-style bind, in a real caller) may
      // throw an error whose own message carries a bound value, so only a safe label is ever
      // logged, never the error itself.
      expect(errSpy).toHaveBeenCalledWith("[events] processing failed", e.type, e.id, e.source, "Error");
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

  it("concurrent first events for a new aggregate apply in sequence order, never out of order", async () => {
    const seq5 = makeEvent(5, "org:race");
    const seq3 = makeEvent(3, "org:race");
    const [r5, r3] = await Promise.all([post(app, seq5), post(app, seq3)]);

    if (raceOrder.length === 1) {
      // Whichever request's transaction created the position row first serialized the
      // other behind it; since 5 is the larger sequence, it can never be stale.
      expect(raceOrder).toEqual([5]);
      expect(r5.body.outcome).toBe("applied");
      expect(r3.body.outcome).toBe("stale");
    } else {
      // Both applied only if 3 ran to completion (and committed its position) before 5
      // started — the side effect for 3 must never land after 5's.
      expect(raceOrder).toEqual([3, 5]);
      expect(r5.body.outcome).toBe("applied");
      expect(r3.body.outcome).toBe("applied");
    }
  });

  it("onApplied throwing still returns 200 applied, does not block the duplicate check, and logs no address", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      onAppliedShouldThrow = true;
      const e = makeEvent(1, "org:onapplied-fail");
      const res = await post(app, e);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ outcome: "applied" });
      expect(onAppliedCalls).toEqual([e.id]);
      expect(errSpy).toHaveBeenCalledWith("[events] onApplied failed", e.type, e.id, "Error");
      const logged = errSpy.mock.calls.flat().map(String).join(" ");
      expect(logged).not.toContain("someone@example.test");
      // The event is already committed as applied, so a retry is a duplicate — onApplied
      // does not rerun just because it failed last time.
      onAppliedShouldThrow = false;
      const retry = await post(app, e);
      expect(retry.body).toEqual({ outcome: "duplicate" });
      expect(onAppliedCalls).toEqual([e.id]);
    } finally {
      onAppliedShouldThrow = false;
      errSpy.mockRestore();
    }
  });

  it("accepts bodies up to MAX_EVENT_BYTES and rejects larger ones with 413", async () => {
    const fits = { ...makeEvent(1, "big:fits", "future.thing"), data: { pad: "" } };
    fits.data.pad = "x".repeat(MAX_EVENT_BYTES - JSON.stringify(fits).length);
    expect(JSON.stringify(fits).length).toBe(MAX_EVENT_BYTES);
    expect((await post(app, fits)).body).toEqual({ outcome: "ignored" });

    const tooBig = { ...makeEvent(1, "big:over", "future.thing"), data: { pad: "x".repeat(MAX_EVENT_BYTES) } };
    expect((await post(app, tooBig)).status).toBe(413);
  });

  it("fails loudly with 500 when mounted behind a body parser that already consumed the body", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const misMounted = express();
      misMounted.use(express.json());
      misMounted.use(createEventReceiver({ db: tdb.db, secrets: { core: "k" }, handlers: {} }));
      const res = await post(misMounted, makeEvent(1, "org:mismounted"));
      expect(res.status).toBe(500);
      expect(res.body).toEqual({ error: "[events] receiver must be mounted before body parsers" });
      expect(errSpy).toHaveBeenCalledWith("[events] receiver must be mounted before body parsers");
    } finally {
      errSpy.mockRestore();
    }
  });

  it("rejects an envelope whose source differs from the signed x-event-source with 400", async () => {
    // Signed with core's secret, but claims to come from another producer.
    const res = await post(app, { ...makeEvent(1, "org:spoof"), source: "news-api" });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "source mismatch" });
    const inbox = await tdb.pool.query("SELECT 1 FROM inbox_events WHERE source = 'news-api'");
    expect(inbox.rowCount).toBe(0);
  });

  it("rejects an unknown source with 401", async () => {
    const res = await post(app, { ...makeEvent(1, "org:unknown"), source: "nobody" }, { source: "nobody" });
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "invalid signature" });
  });

  it("rejects a prototype-chain source like 'constructor' with 401 instead of 500", async () => {
    const res = await post(app, makeEvent(1, "org:proto"), { source: "constructor" });
    expect(res.status).toBe(401);
  });
});

describe("createEventReceiver with a handler resolver", () => {
  let tdb: TestDatabase;
  beforeAll(async () => {
    tdb = await createTestDatabase({ migrationsFolder });
  });
  afterAll(async () => {
    await tdb.drop();
  });

  it("asks the resolver with the whole envelope; undefined means ignored", async () => {
    const seen: string[] = [];
    const app = express();
    app.use(
      createEventReceiver({
        db: tdb.db,
        secrets: { core: "k", other: "o" },
        handlers: (event) => (event.source === "core" ? async () => void seen.push(event.id) : undefined),
      }),
    );
    const fromCore = makeEvent(1, "org:a");
    expect((await post(app, fromCore)).body).toEqual({ outcome: "applied" });
    const fromOther = { ...makeEvent(1, "org:b"), source: "other" };
    expect((await post(app, fromOther, { source: "other", secret: "o" })).body).toEqual({ outcome: "ignored" });
    expect(seen).toEqual([fromCore.id]);
  });
});

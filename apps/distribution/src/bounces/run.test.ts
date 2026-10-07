import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { sql } from "drizzle-orm";
import type { Db, TestDatabase } from "@gcpe/db-kit";
import { createDistributionTestDb } from "../../test/helpers";
import { distributionSettings } from "../db/schema";
import { runBouncesIfDue } from "./run";
import type { BounceSource } from "./source";

const UNDELIVERABLE_RAW = [
  "Subject: Undeliverable: Weekend clinics open across B.C.",
  "",
  "Your message could not be delivered to someone@example.test [#;550]",
].join("\r\n");

function stubSource(entries: { id: string; raw: string }[]): BounceSource & { markProcessed: ReturnType<typeof vi.fn> } {
  return {
    fetchNew: vi.fn().mockResolvedValue(entries),
    markProcessed: vi.fn().mockResolvedValue(undefined),
  };
}

/** Wraps a real Db so its Nth `.transaction()` call rejects instead of running — every other
 * method (select/update/execute, and every other transaction call) passes straight through to
 * the real database. Used to simulate one message's processing genuinely failing (a transient
 * DB error) without disturbing the rest of the run. */
function dbFailingNthTransaction(db: Db, n: number): Db {
  let count = 0;
  return new Proxy(db, {
    get(target, prop, receiver) {
      if (prop === "transaction") {
        return (fn: Parameters<Db["transaction"]>[0]) => {
          count++;
          if (count === n) return Promise.reject(new Error("simulated transient DB failure"));
          return (target.transaction as (f: typeof fn) => unknown)(fn);
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  }) as Db;
}

describe("runBouncesIfDue", () => {
  let tdb: TestDatabase;

  beforeAll(async () => {
    tdb = await createDistributionTestDb();
  });
  afterAll(async () => {
    await tdb.drop();
  });
  beforeEach(async () => {
    await tdb.db.update(distributionSettings).set({ bouncesCheckedAt: null }).where(sql`id = 1`);
  });

  it("is not due within 15 minutes of the last check", async () => {
    await tdb.db.update(distributionSettings).set({ bouncesCheckedAt: sql`now() - interval '10 minutes'` }).where(sql`id = 1`);
    const source = stubSource([{ id: "m1", raw: UNDELIVERABLE_RAW }]);

    const result = await runBouncesIfDue(tdb.db, source);

    expect(result).toEqual({ ran: false, fetched: 0, bounces: 0, matched: 0, ignored: 0 });
    expect(source.fetchNew).not.toHaveBeenCalled();
    expect(source.markProcessed).not.toHaveBeenCalled();
  });

  it("is due once bounces_checked_at is null (never checked)", async () => {
    const source = stubSource([]);
    const result = await runBouncesIfDue(tdb.db, source);
    expect(result.ran).toBe(true);
  });

  it("is due again after 15 minutes have passed", async () => {
    await tdb.db.update(distributionSettings).set({ bouncesCheckedAt: sql`now() - interval '16 minutes'` }).where(sql`id = 1`);
    const source = stubSource([{ id: "m1", raw: UNDELIVERABLE_RAW }]);

    const result = await runBouncesIfDue(tdb.db, source);

    expect(result.ran).toBe(true);
    expect(result.fetched).toBe(1);
    expect(result.bounces).toBe(1);
    expect(source.markProcessed).toHaveBeenCalledWith(["m1"]);
  });

  it("two racing runs: exactly one fetches, the other reports not due", async () => {
    await tdb.db.update(distributionSettings).set({ bouncesCheckedAt: sql`now() - interval '16 minutes'` }).where(sql`id = 1`);
    const source = stubSource([{ id: "m1", raw: UNDELIVERABLE_RAW }]);

    const [a, b] = await Promise.all([runBouncesIfDue(tdb.db, source), runBouncesIfDue(tdb.db, source)]);

    const ranResults = [a, b].filter((r) => r.ran);
    expect(ranResults).toHaveLength(1);
    expect(source.fetchNew).toHaveBeenCalledTimes(1);
  });

  it("a message that fails to process is still marked processed, and the rest proceed", async () => {
    const entries = [
      { id: "ok-1", raw: UNDELIVERABLE_RAW },
      { id: "bad-1", raw: UNDELIVERABLE_RAW },
      { id: "ok-2", raw: UNDELIVERABLE_RAW },
    ];
    const source = stubSource(entries);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    // Transaction call 1 is the gate claim itself; call 2 is ok-1's own recordBounce
    // transaction; call 3 -- the one made to fail -- is bad-1's; call 4 is ok-2's. Failing the
    // middle message exercises both a success before and a success after the failure.
    const flakyDb = dbFailingNthTransaction(tdb.db, 3);

    const result = await runBouncesIfDue(flakyDb, source);

    expect(result.ran).toBe(true);
    expect(result.fetched).toBe(3);
    // Only the two messages whose own transaction succeeded are tallied.
    expect(result.bounces).toBe(2);
    expect(source.markProcessed).toHaveBeenCalledWith(["ok-1", "bad-1", "ok-2"]);
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it("marks everything fetched as processed, including ignored (non-bounce) messages", async () => {
    const entries = [
      { id: "ignored-1", raw: "Subject: Hello\r\n\r\nNot a bounce at all." },
      { id: "bounce-1", raw: UNDELIVERABLE_RAW },
    ];
    const source = stubSource(entries);

    const result = await runBouncesIfDue(tdb.db, source);

    expect(result.fetched).toBe(2);
    expect(result.bounces).toBe(1);
    expect(result.ignored).toBe(1);
    expect(source.markProcessed).toHaveBeenCalledWith(["ignored-1", "bounce-1"]);
  });

  it("does not call markProcessed when nothing was fetched", async () => {
    const source = stubSource([]);
    const result = await runBouncesIfDue(tdb.db, source);
    expect(result).toEqual({ ran: true, fetched: 0, bounces: 0, matched: 0, ignored: 0 });
    expect(source.markProcessed).not.toHaveBeenCalled();
  });

  it("does not double-count bounces/ignored for a duplicate sourceId, mirroring matched's own skip", async () => {
    // In practice a duplicate arises from the *same* message being fetched again across runs
    // (e.g. after a markProcessed failure leaves it unprocessed) -- fed twice in one fetchNew
    // here only to exercise run.ts's own counting logic deterministically, in one run.
    const source = stubSource([
      { id: "dup-1", raw: UNDELIVERABLE_RAW },
      { id: "dup-1", raw: UNDELIVERABLE_RAW },
    ]);

    const result = await runBouncesIfDue(tdb.db, source);

    expect(result.fetched).toBe(2);
    expect(result.bounces).toBe(1);
    expect(result.ignored).toBe(0);
    expect(source.markProcessed).toHaveBeenCalledWith(["dup-1", "dup-1"]);
  });

  it("resolves with its counts, logging only a count, when source.markProcessed itself throws", async () => {
    // A fresh, never-used-elsewhere source id -- run.test.ts never truncates `bounces` between
    // tests, so reusing an id another test already recorded (e.g. "m1") would read back as a
    // duplicate here and make this assertion about *this* fix's counting, not that one's.
    const entries = [{ id: "markprocessed-throws-1", raw: UNDELIVERABLE_RAW }];
    const source: BounceSource = {
      fetchNew: vi.fn().mockResolvedValue(entries),
      markProcessed: vi.fn().mockRejectedValue(new Error("simulated source failure")),
    };
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await runBouncesIfDue(tdb.db, source);

    expect(result).toEqual({ ran: true, fetched: 1, bounces: 1, matched: 0, ignored: 0 });
    expect(errorSpy).toHaveBeenCalled();
    const logged = errorSpy.mock.calls.flat().map(String).join(" ");
    expect(logged).not.toContain("markprocessed-throws-1");
    expect(logged).toContain("1");
    errorSpy.mockRestore();
  });

  it("defaults the fetch limit to 200, honours an override", async () => {
    const source = stubSource([]);
    await runBouncesIfDue(tdb.db, source);
    expect(source.fetchNew).toHaveBeenCalledWith(200);

    await tdb.db.update(distributionSettings).set({ bouncesCheckedAt: null }).where(sql`id = 1`);
    const source2 = stubSource([]);
    await runBouncesIfDue(tdb.db, source2, { limit: 5 });
    expect(source2.fetchNew).toHaveBeenCalledWith(5);
  });
});

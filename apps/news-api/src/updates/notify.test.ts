import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import pg from "pg";
import type { TestDatabase } from "@gcpe/db-kit";
import { createNewsTestDb } from "../../test/helpers";
import { listenForUpdates, notifyUpdate, type UpdateTarget } from "./notify";

// A connection outside the pool under test, so queries issued through it never interact
// with a spy installed on that pool's own `connect`.
async function withRawClient<T>(connectionString: string, fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

async function findAndKillListenBackend(connectionString: string): Promise<void> {
  await withRawClient(connectionString, async (c) => {
    const { rows } = await c.query<{ pid: number }>(
      "SELECT pid FROM pg_stat_activity WHERE query ILIKE 'LISTEN %' AND pid <> pg_backend_pid() AND datname = current_database()",
    );
    expect(rows).toHaveLength(1);
    await c.query("SELECT pg_terminate_backend($1)", [rows[0]!.pid]);
  });
}

// pg_stat_activity is cluster-wide, not scoped to the connection's database — other test
// files hold their own LISTEN connections (on their own throwaway databases) at the same
// time under vitest's default parallel-file execution, so this must filter to the current
// database or it'll pick up an unrelated backend and the pid-match assertion will be racy.
async function findListenBackendPid(tdb: TestDatabase): Promise<number> {
  const { rows } = await tdb.pool.query<{ pid: number }>(
    "SELECT pid FROM pg_stat_activity WHERE query ILIKE 'LISTEN %' AND pid <> pg_backend_pid() AND datname = current_database()",
  );
  expect(rows).toHaveLength(1);
  return rows[0]!.pid;
}

describe("notify", () => {
  let tdb: TestDatabase;
  beforeAll(async () => {
    tdb = await createNewsTestDb();
  });
  afterAll(async () => {
    await tdb.drop();
  });

  it("chunks a large key list across multiple notifications, each under the payload limit", async () => {
    const keys = Array.from({ length: 2000 }, (_, i) => `very-long-release-key-${i}-${"x".repeat(40)}`);
    const got: [UpdateTarget, string[]][] = [];
    const { stop } = await listenForUpdates(tdb.pool, (t, k) => got.push([t, k]));

    await tdb.db.transaction((tx) => notifyUpdate(tx, "PostUpdate", keys));
    await new Promise((r) => setTimeout(r, 300));
    await stop();

    expect(got.length).toBeGreaterThan(1);
    for (const [target, chunk] of got) {
      expect(target).toBe("PostUpdate");
      expect(Buffer.byteLength(JSON.stringify({ target, keys: chunk }), "utf8")).toBeLessThan(7500);
    }
    expect(got.flatMap(([, k]) => k)).toEqual(keys);
  });

  it("throws a clear error instead of sending an oversized notify for one huge key", async () => {
    const hugeKey = "x".repeat(8000);
    await expect(tdb.db.transaction((tx) => notifyUpdate(tx, "PostUpdate", [hugeKey]))).rejects.toThrow(
      "notify payload for one key exceeds 7500 bytes",
    );
  });

  it(
    "reconnects after the LISTEN connection is dropped, and resumes delivering notifications",
    async () => {
      const got: [UpdateTarget, string[]][] = [];
      let reconnected = 0;
      const { stop } = await listenForUpdates(tdb.pool, (t, k) => got.push([t, k]), { onReconnect: () => reconnected++ });

      const pid = await findListenBackendPid(tdb);
      await tdb.pool.query("SELECT pg_terminate_backend($1)", [pid]);

      await new Promise((r) => setTimeout(r, 500));
      expect(reconnected).toBe(1);

      await tdb.db.transaction((tx) => notifyUpdate(tx, "PostUpdate", ["after-reconnect"]));
      await new Promise((r) => setTimeout(r, 200));
      expect(got).toEqual([["PostUpdate", ["after-reconnect"]]]);

      await stop();
    },
    10_000,
  );

  // Final review M4: readiness must report unavailable while the LISTEN connection is down.
  it(
    "isListening() is false while the LISTEN connection is down/reconnecting, true once back, false after stop()",
    async () => {
      const local = await createNewsTestDb();
      try {
        const listener = await listenForUpdates(local.pool, () => {});
        expect(listener.isListening()).toBe(true);

        // Hold the reconnect attempt open so the "down" window is observable deterministically.
        let release!: () => void;
        const gate = new Promise<void>((r) => (release = r));
        const realConnect = local.pool.connect.bind(local.pool);
        vi.spyOn(local.pool, "connect").mockImplementationOnce(async () => {
          await gate;
          return realConnect();
        });

        await findAndKillListenBackend(local.url);
        await vi.waitFor(() => expect(listener.isListening()).toBe(false));

        release();
        await vi.waitFor(() => expect(listener.isListening()).toBe(true));

        await listener.stop();
        expect(listener.isListening()).toBe(false);
      } finally {
        vi.restoreAllMocks();
        await local.drop();
      }
    },
    10_000,
  );

  // Final review M5: once a discarded client's listeners are removed, a further 'error' from
  // it (pg can emit more than one as a socket dies) must never be an unhandled 'error' event —
  // EventEmitter throws on those, crashing the process. The exposed window is cleanup():
  // listeners are removed *before* the awaited UNLISTEN, so the client has no 'error'
  // listener at all while that query is in flight.
  it(
    "an 'error' emitted by a discarded client — during cleanup's UNLISTEN or after release — does not throw",
    async () => {
      const local = await createNewsTestDb();
      try {
        const realConnect = local.pool.connect.bind(local.pool);
        const clients: pg.PoolClient[] = [];
        vi.spyOn(local.pool, "connect").mockImplementation(async () => {
          const c = await realConnect();
          clients.push(c);
          return c;
        });
        const listener = await listenForUpdates(local.pool, () => {});

        // Broken-connection path: the first client is discarded and a second one LISTENs.
        const first = clients[0]!;
        await findAndKillListenBackend(local.url);
        await vi.waitFor(() => expect(clients.length).toBe(2));
        expect(() => first.emit("error", new Error("late error 1"))).not.toThrow();
        expect(() => first.emit("error", new Error("late error 2"))).not.toThrow();

        // stop() path: emit twice while UNLISTEN is in flight.
        const second = clients[1]!;
        const realQuery = second.query.bind(second) as (q: string) => Promise<unknown>;
        const thrown: unknown[] = [];
        vi.spyOn(second, "query").mockImplementationOnce((async (q: string) => {
          await new Promise((r) => setTimeout(r, 10));
          for (const n of [1, 2]) {
            try {
              second.emit("error", new Error(`error ${n} during UNLISTEN`));
            } catch (e) {
              thrown.push(e);
            }
          }
          return realQuery(q);
        }) as never);
        await listener.stop();
        expect(thrown).toEqual([]);
        expect(() => second.emit("error", new Error("late error after stop"))).not.toThrow();
      } finally {
        vi.restoreAllMocks();
        await local.drop();
      }
    },
    10_000,
  );

  it(
    "stop() after the connection breaks resolves without leaking a connection",
    async () => {
      const local = await createNewsTestDb();
      try {
        const { stop } = await listenForUpdates(local.pool, () => {});

        const pid = await findListenBackendPid(local);
        await local.pool.query("SELECT pg_terminate_backend($1)", [pid]);

        // Stop immediately, racing whatever reconnect attempt the broken connection triggers.
        await stop();
      } finally {
        await local.drop();
      }
      // drop() awaits pool.end(), which itself waits for every checked-out client (including
      // one a race let the reconnect loop pick up after stop()) to be released before it
      // resolves — so by this point totalCount reflects a pool with nothing left outstanding.
      expect(local.pool.totalCount).toBe(0);
    },
    10_000,
  );

  it(
    "releases the client when LISTEN itself fails, without leaking across reconnect retries",
    async () => {
      const local = await createNewsTestDb();
      try {
        const { stop } = await listenForUpdates(local.pool, () => {});

        // Induce the LISTEN query itself to fail on the next few reconnect attempts, so the
        // reconnect loop has to retry through connect()'s own failure path repeatedly — the
        // exact path that used to leak a checked-out client on every failed attempt.
        let failuresLeft = 3;
        const observedTotals: number[] = [];
        const realConnect = local.pool.connect.bind(local.pool);
        vi.spyOn(local.pool, "connect").mockImplementation(async () => {
          const c = await realConnect();
          if (failuresLeft > 0) {
            failuresLeft--;
            vi.spyOn(c, "query").mockImplementationOnce(() => {
              observedTotals.push(local.pool.totalCount);
              return Promise.reject(new Error("simulated LISTEN failure"));
            });
          }
          return c;
        });

        await findAndKillListenBackend(local.url);

        // Outlasts the induced failures' backoff (100 + 200 + 400ms) plus the final,
        // unmocked successful connect.
        await new Promise((r) => setTimeout(r, 1500));

        expect(failuresLeft).toBe(0); // the mock actually engaged for all three attempts
        expect(Math.max(0, ...observedTotals)).toBeLessThanOrEqual(1); // never more than the one failing client
        expect(local.pool.totalCount).toBe(1); // exactly the one, now-successfully-reconnected client

        await stop();
        expect(local.pool.totalCount).toBe(0);
      } finally {
        vi.restoreAllMocks();
        await local.drop();
      }
    },
    10_000,
  );

  it(
    "stop() mid-reconnect resolves only after the in-flight client is released",
    async () => {
      const local = await createNewsTestDb();
      try {
        const listener = await listenForUpdates(local.pool, () => {});
        const { stop } = listener;

        // Delay the next connect() call (the reconnect attempt) so stop() can reliably be
        // called while it's still in flight, rather than racing real connection timing.
        const RECONNECT_DELAY_MS = 300;
        const realConnect = local.pool.connect.bind(local.pool);
        vi.spyOn(local.pool, "connect").mockImplementationOnce(async () => {
          await new Promise((r) => setTimeout(r, RECONNECT_DELAY_MS));
          return realConnect();
        });

        await findAndKillListenBackend(local.url);

        // Poll (rather than sleep a fixed 50ms) until onBroken has fired — releasing the old
        // client and kicking off the now-delayed reconnect attempt, which hasn't acquired a
        // new client yet. totalCount stays 0 for the whole RECONNECT_DELAY_MS window.
        await vi.waitFor(
          () => {
            expect(listener.isListening()).toBe(false);
            expect(local.pool.totalCount).toBe(0);
          },
          { timeout: 2000, interval: 5 },
        );

        const before = Date.now();
        await stop();
        const elapsed = Date.now() - before;

        // The discriminating check: stop() must block on the delayed reconnect's own
        // connect-then-immediately-clean-up cycle (since `stopped` is already true by the
        // time it completes) rather than resolving immediately and leaving that cleanup to
        // happen in the background, unobserved, after stop() has already returned.
        expect(elapsed).toBeGreaterThanOrEqual(RECONNECT_DELAY_MS - 50);
        expect(local.pool.totalCount).toBe(0);
      } finally {
        vi.restoreAllMocks();
        await local.drop();
      }
    },
    10_000,
  );
});

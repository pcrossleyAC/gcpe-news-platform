import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { TestDatabase } from "@gcpe/db-kit";
import { createNewsTestDb } from "../../test/helpers";
import { listenForUpdates, notifyUpdate, type UpdateTarget } from "./notify";

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
    const stop = await listenForUpdates(tdb.pool, (t, k) => got.push([t, k]));

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

  it(
    "reconnects after the LISTEN connection is dropped, and resumes delivering notifications",
    async () => {
      const got: [UpdateTarget, string[]][] = [];
      let reconnected = 0;
      const stop = await listenForUpdates(tdb.pool, (t, k) => got.push([t, k]), { onReconnect: () => reconnected++ });

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

  it(
    "stop() after the connection breaks resolves without leaking a connection",
    async () => {
      const local = await createNewsTestDb();
      try {
        const stop = await listenForUpdates(local.pool, () => {});

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
});

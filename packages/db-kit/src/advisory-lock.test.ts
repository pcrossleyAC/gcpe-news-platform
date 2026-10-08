import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withAdvisoryLock } from "./advisory-lock";
import { createTestDatabase, type TestDatabase } from "./test-db";

const migrationsFolder = fileURLToPath(new URL("../test/migrations", import.meta.url));
const KEY = [0x67637065, 99] as const;

class Busy extends Error {}

describe("withAdvisoryLock", () => {
  let tdb: TestDatabase;
  beforeAll(async () => {
    tdb = await createTestDatabase({ migrationsFolder });
  });
  afterAll(async () => tdb.drop());

  const heldElsewhere = async () => {
    const { rows } = await tdb.pool.query<{ n: number }>("SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND classid = $1 AND objid = $2", [...KEY]);
    return rows[0]!.n > 0;
  };

  it("runs fn holding the lock, refuses a second holder without running it, and releases afterwards", async () => {
    let inner: unknown;
    const result = await withAdvisoryLock(tdb.db, KEY, () => new Busy(), async () => {
      expect(await heldElsewhere()).toBe(true);
      inner = await withAdvisoryLock(tdb.db, KEY, () => new Busy(), async () => "ran").catch((e: unknown) => e);
      return "done";
    });
    expect(result).toBe("done");
    expect(inner).toBeInstanceOf(Busy);
    expect(await heldElsewhere()).toBe(false);
  });

  it("releases the lock when fn throws", async () => {
    await expect(withAdvisoryLock(tdb.db, KEY, () => new Busy(), async () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    expect(await heldElsewhere()).toBe(false);
    expect(await withAdvisoryLock(tdb.db, KEY, () => new Busy(), async () => 1)).toBe(1);
  });
});

import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { ageMsOf, heldBy, lockTokenOf, ownedPending, sqlNow, sqlNowPlus, stopwatch } from "./claim";
import { createTestDatabase, type TestDatabase } from "./test-db";

const migrationsFolder = fileURLToPath(new URL("../test/migrations", import.meta.url));

describe("claim clock helpers", () => {
  let tdb: TestDatabase;
  beforeAll(async () => {
    tdb = await createTestDatabase({ migrationsFolder });
    await tdb.pool.query(`CREATE TABLE jobs (
      id int PRIMARY KEY,
      status text NOT NULL DEFAULT 'pending',
      next_attempt_at timestamptz NOT NULL DEFAULT now(),
      locked_until timestamptz,
      created_at timestamptz NOT NULL DEFAULT now())`);
  });
  afterAll(async () => {
    await tdb.drop();
  });
  beforeEach(async () => {
    await tdb.pool.query("TRUNCATE jobs");
  });

  const col = (name: string) => sql.identifier(name);

  it("sqlNow() is the database's own now(); with a test clock, it binds that clock's value", async () => {
    const db = await tdb.db.execute<{ same: boolean }>(sql`SELECT ${sqlNow()} = now() AS same`);
    expect(db.rows[0]!.same).toBe(true);

    const fixed = new Date("2026-10-03T17:00:30.250Z");
    const hooked = await tdb.db.execute<{ iso: string }>(sql`SELECT ${lockTokenOf(sqlNow(() => fixed))} AS iso`);
    expect(hooked.rows[0]!.iso).toBe("2026-10-03T17:00:30.250000Z");
  });

  it("a row stamped by a column default is due to a claim that runs right after it (no JS-ms vs DB-µs race)", async () => {
    // The old flake: a claim comparing `next_attempt_at` (Postgres µs) against a JS Date
    // (ms, taken from a different clock) called the row "not due yet" when both landed in the
    // same millisecond. With the database's own clock on both sides it can't.
    for (let i = 0; i < 200; i++) {
      await tdb.pool.query("INSERT INTO jobs (id) VALUES ($1)", [i]);
      const due = await tdb.db.execute<{ id: number }>(sql`SELECT id FROM jobs WHERE id = ${i} AND ${col("next_attempt_at")} <= ${sqlNow()}`);
      expect(due.rows).toHaveLength(1);
    }
  });

  it("lockTokenOf round-trips a microsecond lock exactly, and heldBy matches only that exact value", async () => {
    await tdb.pool.query("INSERT INTO jobs (id, locked_until) VALUES (1, '2026-10-03T17:00:00.123456Z')");
    const [row] = (await tdb.db.execute<{ token: string }>(sql`SELECT ${lockTokenOf(col("locked_until"))} AS token FROM jobs WHERE id = 1`)).rows;
    expect(row!.token).toBe("2026-10-03T17:00:00.123456Z");

    const held = await tdb.db.execute(sql`SELECT 1 FROM jobs WHERE ${heldBy(col("locked_until"), row!.token)}`);
    expect(held.rows).toHaveLength(1);
    // What a JS Date round trip would have produced (millisecond-truncated) is a different lock.
    const viaDate = new Date(row!.token).toISOString();
    const notHeld = await tdb.db.execute(sql`SELECT 1 FROM jobs WHERE ${heldBy(col("locked_until"), viaDate)}`);
    expect(notHeld.rows).toHaveLength(0);
  });

  it("sqlNowPlus adds milliseconds to the statement's now (test clock: exactly)", async () => {
    const fixed = new Date("2026-10-03T17:00:00.000Z");
    const r = await tdb.db.execute<{ iso: string; delta_ms: number }>(
      sql`SELECT ${lockTokenOf(sqlNowPlus(1500.5, () => fixed))} AS iso, (extract(epoch from (${sqlNowPlus(60_000)} - now())) * 1000)::float8 AS delta_ms`,
    );
    expect(r.rows[0]!.iso).toBe("2026-10-03T17:00:01.500500Z");
    expect(Number(r.rows[0]!.delta_ms)).toBe(60_000);
  });

  it("ageMsOf measures from a column to the statement's now", async () => {
    await tdb.pool.query("INSERT INTO jobs (id, created_at) VALUES (1, '2026-10-03T17:00:00Z')");
    const now = sqlNow(() => new Date("2026-10-04T17:00:00.500Z"));
    const r = await tdb.db.execute<{ age: number }>(sql`SELECT ${ageMsOf(col("created_at"), now)} AS age FROM jobs WHERE id = 1`);
    expect(Number(r.rows[0]!.age)).toBe(24 * 3_600_000 + 500);
  });

  it("ownedPending matches a pending row holding the token, and nothing else", async () => {
    await tdb.pool.query(`INSERT INTO jobs (id, status, locked_until) VALUES
      (1, 'pending', '2026-10-03T17:00:00.000001Z'),
      (2, 'sent',    '2026-10-03T17:00:00.000001Z'),
      (3, 'pending', '2026-10-03T17:00:00.000002Z')`);
    const r = await tdb.db.execute<{ id: number }>(
      sql`SELECT id FROM jobs WHERE ${ownedPending({ status: col("status"), lockedUntil: col("locked_until") }, "2026-10-03T17:00:00.000001Z")}`,
    );
    expect(r.rows.map((x) => x.id)).toEqual([1]);
  });

  it("stopwatch is monotonic elapsed time", async () => {
    const elapsed = stopwatch();
    const a = elapsed();
    await new Promise((r) => setTimeout(r, 20));
    const b = elapsed();
    expect(a).toBeGreaterThanOrEqual(0);
    expect(b - a).toBeGreaterThanOrEqual(15);
  });
});

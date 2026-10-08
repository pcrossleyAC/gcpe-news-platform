import pg from "pg";
import type { Db } from "./db";

/**
 * Runs `fn` holding the session-level advisory lock `key` (the two-int form: see db.ts's
 * MIGRATION_LOCK for the key space), taken with `pg_try_advisory_lock` on a dedicated connection
 * -- never a pooled one query by query, which could drop the lock between statements. When
 * another session already holds it, throws `busy()` without running `fn` at all. The lock is
 * released when `fn` settles; if the unlock itself fails, the connection is discarded, which
 * releases it anyway.
 */
export async function withAdvisoryLock<T>(db: Db, key: readonly [number, number], busy: () => Error, fn: () => Promise<T>): Promise<T> {
  const client = (db as Db & { $client: pg.Pool | pg.Client }).$client;
  const conn = client instanceof pg.Pool ? await client.connect() : client;
  const release = (broken: boolean) => {
    if ("release" in conn && typeof conn.release === "function") conn.release(broken);
  };
  let locked: boolean;
  try {
    const { rows } = await conn.query<{ locked: boolean }>("SELECT pg_try_advisory_lock($1, $2) AS locked", [...key]);
    locked = rows[0]?.locked === true;
  } catch (e) {
    release(true);
    throw e;
  }
  if (!locked) {
    release(false);
    throw busy();
  }
  let broken = false;
  try {
    return await fn();
  } finally {
    await conn.query("SELECT pg_advisory_unlock($1, $2)", [...key]).catch(() => {
      broken = true;
    });
    release(broken);
  }
}

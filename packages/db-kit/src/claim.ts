import { sql, type SQL, type SQLWrapper } from "drizzle-orm";

/**
 * SQL-building pieces shared by the four claim → ownership-token → guarded-terminal-write
 * workers (packages/events dispatcher, apps/distribution sender, apps/nod send-jobs,
 * apps/nrms publisher). The rule they encode (P2-R22 D1): every due/lock/backoff/age
 * comparison uses ONE clock — the database's — never a JS `Date` compared against a column
 * Postgres stamped with its own `now()`.
 *
 * Each worker keeps its own claim statement (their joins, ordering and RETURNING lists differ
 * enough that a generic "claim" function would just be a SQL template engine); what is shared
 * is how "now", lock expiry, the ownership token and ages are expressed.
 */

/**
 * Test hook accepted by every worker as its `now` option. When given, its value is bound as
 * the statement's "now" (so a test can simulate time passing); when absent, SQL `now()` is
 * used. Production call sites never pass one.
 */
export type TestClock = () => Date;

/**
 * The "now" a statement should use: Postgres's `now()` (the start of the current
 * transaction — for an autocommitted statement, the statement itself), or the test clock's
 * value bound as a timestamptz. Evaluate once per statement and reuse the fragment, so every
 * comparison in that statement sees the same instant.
 */
export function sqlNow(clock?: TestClock): SQL {
  return clock ? sql`${clock().toISOString()}::timestamptz` : sql`now()`;
}

/** An interval of `ms` milliseconds (fractional values keep microsecond precision). */
export function sqlInterval(ms: number): SQL {
  return sql`(${ms}::double precision * interval '1 millisecond')`;
}

/** `now + ms`, for lock expiry and backoff (`next_attempt_at`) writes. */
export function sqlNowPlus(ms: number, clock?: TestClock): SQL {
  return sql`(${sqlNow(clock)} + ${sqlInterval(ms)})`;
}

/**
 * The ownership token a claim hands back: the exact `locked_until` value the claim wrote, as
 * text with full microsecond precision. A JS `Date` can't carry it (millisecond resolution,
 * and drizzle's raw `execute` returns timestamptz as session-timezone text anyway), so the
 * token is kept opaque and compared back in SQL via {@link heldBy}.
 */
export type LockToken = string;

/** SELECT/RETURNING expression yielding the {@link LockToken} for a `locked_until` column. */
export function lockTokenOf(lockedUntil: SQLWrapper): SQL<LockToken> {
  return sql<LockToken>`to_char(${lockedUntil} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
}

/** `locked_until = <token>`: true only while the lock is still the one this call's claim set. */
export function heldBy(lockedUntil: SQLWrapper, token: LockToken): SQL {
  return sql`${lockedUntil} = ${token}::timestamptz`;
}

/**
 * The guard on every terminal/ownership write: the row is still `pending` and still holds
 * this call's lock. If another worker reclaimed it (our lock expired mid-work), the write
 * matches 0 rows and that worker's outcome stands.
 */
export function ownedPending(cols: { status: SQLWrapper; lockedUntil: SQLWrapper }, token: LockToken): SQL {
  return sql`(${cols.status} = 'pending' AND ${heldBy(cols.lockedUntil, token)})`;
}

/** Milliseconds from `since` to the statement's "now", as a float8 (a JS number). */
export function ageMsOf(since: SQLWrapper, now: SQL): SQL<number> {
  return sql<number>`(extract(epoch from (${now} - ${since})) * 1000)::float8`;
}

/**
 * Monotonic elapsed time since this was called. Workers start one immediately before sending
 * their claim, so `elapsed()` is never less than the time since the database evaluated the
 * claim's `now()` — making "has my lock (claim now + lockMs) nearly expired?" and "how old is
 * this row now (age at claim + elapsed)?" conservative, without comparing a wall-clock JS Date
 * to a database timestamp and without an extra round trip per check.
 */
export function stopwatch(): () => number {
  const start = performance.now();
  return () => performance.now() - start;
}

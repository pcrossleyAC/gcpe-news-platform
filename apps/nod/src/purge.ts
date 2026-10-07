import { randomUUID } from "node:crypto";
import { and, eq, ne, sql, type SQL } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { sqlInterval, sqlNow, type Db, type DbOrTx, type TestClock } from "@gcpe/db-kit";
import { safeErrorLabel } from "@gcpe/http-kit";
import { dailyCutoff, todaysCutoff } from "./digest";
import { nodSettings, subscriberLinks, subscribers } from "./db/schema";
import { withLockedSubscriber } from "./locks";
import { keepMediaOptOuts } from "./opt-outs";
import { writeOpsLog } from "./settings";

export const PURGE_HOUR = 3;
export const UNCONFIRMED_DAYS = 10;
export const ENDED_DAYS = 90;
export const LINK_DAYS = 10;
export const SUBSCRIBER_BATCH = 100;
export const RUN_BUDGET_MS = 20_000;
export const RUN_MAX_SUBSCRIBERS = 500;
export const PURGE_ACTOR = "Retention purge";
const LINK_BATCH = 5_000;
const LEASE_MS = 5 * 60_000;
const DAY_MS = 24 * 3_600_000;

export interface PurgeCounts {
  pendingSubscribers: number;
  endedSubscribers: number;
  unusedLinks: number;
  expiredSendLinks: number;
}
const NO_COUNTS: PurgeCounts = { pendingSubscribers: 0, endedSubscribers: 0, unusedLinks: 0, expiredSendLinks: 0 };
const addCounts = (a: PurgeCounts, b: PurgeCounts): PurgeCounts => ({
  pendingSubscribers: a.pendingSubscribers + b.pendingSubscribers,
  endedSubscribers: a.endedSubscribers + b.endedSubscribers,
  unusedLinks: a.unusedLinks + b.unusedLinks,
  expiredSendLinks: a.expiredSendLinks + b.expiredSendLinks,
});

export function describeCounts(c: PurgeCounts): string {
  return `unconfirmed subscribers ${c.pendingSubscribers}, ended subscribers ${c.endedSubscribers}, unused links ${c.unusedLinks}, expired send links ${c.expiredSendLinks}`;
}

/**
 * The one definition of what the purge removes. The preview counts with these conditions and
 * the purge deletes with them, so the two can't drift. Durations are rolling, by the database
 * clock (or the test clock), strictly older than the limit:
 * - unconfirmed (pending) subscribers created more than 10 days ago;
 * - ended (deleted) subscribers whose ended_at is more than 90 days ago, with everything that
 *   cascades from them;
 * - request links created more than 10 days ago that were never used, or never bound to a
 *   subscriber (unconfirmed signups live here, and so does a signup's other verify links, which
 *   confirming one marks used without binding them -- so they wouldn't go with the subscriber);
 * - send links (the manage link in each sent email) expired more than 10 days ago.
 */
export function purgeSelection(now?: TestClock): Record<keyof PurgeCounts, SQL> {
  const n = sqlNow(now);
  const olderThan = (col: AnyPgColumn, days: number) => sql`${col} < ${n} - ${sqlInterval(days * DAY_MS)}`;
  return {
    pendingSubscribers: sql`${subscribers.status} = 'pending' AND ${olderThan(subscribers.createdAt, UNCONFIRMED_DAYS)}`,
    endedSubscribers: sql`${subscribers.status} = 'deleted' AND ${subscribers.endedAt} IS NOT NULL AND ${olderThan(subscribers.endedAt, ENDED_DAYS)}`,
    unusedLinks: sql`${subscriberLinks.origin} = 'request' AND (${subscriberLinks.usedAt} IS NULL OR ${subscriberLinks.subscriberId} IS NULL) AND ${olderThan(subscriberLinks.createdAt, LINK_DAYS)}`,
    expiredSendLinks: sql`${subscriberLinks.origin} = 'send' AND ${olderThan(subscriberLinks.expiresAt, LINK_DAYS)}`,
  };
}

/** What the purge would remove if it ran now (with the switch on). */
export async function previewPurge(db: DbOrTx, now?: TestClock): Promise<PurgeCounts> {
  const sel = purgeSelection(now);
  const { rows } = await db.execute<Record<keyof PurgeCounts, number>>(sql`
    SELECT (SELECT count(*)::int FROM ${subscribers} WHERE ${sel.pendingSubscribers}) AS "pendingSubscribers",
           (SELECT count(*)::int FROM ${subscribers} WHERE ${sel.endedSubscribers}) AS "endedSubscribers",
           (SELECT count(*)::int FROM ${subscriberLinks} WHERE ${sel.unusedLinks}) AS "unusedLinks",
           (SELECT count(*)::int FROM ${subscriberLinks} WHERE ${sel.expiredSendLinks}) AS "expiredSendLinks"`);
  return rows[0]!;
}

/** One bounded, set-based delete. The condition is repeated outside the subquery so a row that
 * changed after the subquery read it (a link used meanwhile) is re-checked, not deleted. */
async function deleteLinks(db: Db, where: SQL): Promise<number> {
  const res = await db.execute(sql`
    DELETE FROM ${subscriberLinks}
     WHERE ${subscriberLinks.id} IN (SELECT ${subscriberLinks.id} FROM ${subscriberLinks} WHERE ${where} LIMIT ${LINK_BATCH})
       AND ${where}`);
  return res.rowCount ?? 0;
}

/** Deletes one subscriber in its own transaction, under their address lock, only if they still
 * match `where` there. Someone who re-subscribed, or was re-added to a media list, after being
 * selected no longer matches and is kept. Their media opt-outs are kept first, as hashes. */
async function purgeSubscriber(db: Db, id: string, where: SQL): Promise<boolean> {
  return withLockedSubscriber(db, id, null, async (tx, s) => {
    if (!s) return false;
    const still = await tx.execute(sql`SELECT 1 FROM ${subscribers} WHERE ${subscribers.id} = ${id} AND ${where}`);
    if (still.rows.length === 0) return false;
    await keepMediaOptOuts(tx, s);
    await tx.delete(subscribers).where(eq(subscribers.id, id));
    return true;
  });
}

export interface PurgeBatchOptions {
  /** The switch. Off: only expired send links are cleared. */
  enabled: boolean;
  /** Date.now() past which the call stops and reports itself unfinished. */
  deadline: number;
  /** At most this many subscribers per call. */
  maxSubscribers?: number;
  batchSize?: number;
  now?: TestClock;
}

/**
 * One bounded pass. Links go set-based, 5,000 per statement; subscribers one per transaction.
 * `finished` is false when the time or subscriber budget ran out with work left, so the
 * nightly run carries on next tick. A subscriber whose delete fails is logged by label and
 * left for the next night, never retried in a loop.
 */
export async function purgeBatch(db: Db, opts: PurgeBatchOptions): Promise<{ counts: PurgeCounts; finished: boolean }> {
  const counts = { ...NO_COUNTS };
  return { counts, finished: await purgeInto(db, opts, counts) };
}

/** {@link purgeBatch}'s work, adding to `counts` as each delete commits, so a caller still
 * knows what was removed when a later step throws. Returns whether the pass finished. */
async function purgeInto(db: Db, opts: PurgeBatchOptions, counts: PurgeCounts): Promise<boolean> {
  const sel = purgeSelection(opts.now);
  const batchSize = opts.batchSize ?? SUBSCRIBER_BATCH;
  const maxSubscribers = opts.maxSubscribers ?? Infinity;
  const outOfTime = () => Date.now() >= opts.deadline;
  const unfinished = () => false;

  const sweep = async (kind: "expiredSendLinks" | "unusedLinks"): Promise<boolean> => {
    for (;;) {
      const deleted = await deleteLinks(db, sel[kind]);
      counts[kind] += deleted;
      if (deleted < LINK_BATCH) return true;
      if (outOfTime()) return false;
    }
  };

  if (!(await sweep("expiredSendLinks"))) return unfinished();
  if (!opts.enabled) return true;
  if (!(await sweep("unusedLinks"))) return unfinished();

  let purged = 0;
  for (const kind of ["pendingSubscribers", "endedSubscribers"] as const) {
    const passedOver: string[] = [];
    for (;;) {
      if (outOfTime() || purged >= maxSubscribers) return unfinished();
      const { rows } = await db.execute<{ id: string }>(sql`
        SELECT ${subscribers.id} AS id FROM ${subscribers}
         WHERE ${sel[kind]} AND NOT (${subscribers.id} = ANY(${sql.param(passedOver)}::uuid[]))
         ORDER BY ${subscribers.id} LIMIT ${batchSize}`);
      for (const { id } of rows) {
        if (outOfTime() || purged >= maxSubscribers) return unfinished();
        try {
          if (await purgeSubscriber(db, id, sel[kind])) {
            counts[kind] += 1;
            purged += 1;
          } else passedOver.push(id);
        } catch (e) {
          passedOver.push(id);
          console.error(`[nod] purge skipped one subscriber: ${safeErrorLabel(e)}`);
        }
      }
      if (rows.length < batchSize) break;
    }
  }
  return true;
}

export interface PurgeRunResult {
  /** The night's 03:00 BC cutoff. */
  cutoff: string;
  counts: PurgeCounts;
  finished: boolean;
  enabled: boolean;
}

type Claim =
  | { kind: "not-due" | "busy" }
  | { kind: "claimed"; lease: string; cutoff: Date; enabled: boolean };

/** Claims tonight's run in one short transaction (nod_settings FOR UPDATE), never across the
 * work itself. Due when tonight's 03:00 has passed and isn't done; a missed night catches up. */
async function claim(db: Db, timeZone: string, now?: TestClock): Promise<Claim> {
  return db.transaction(async (tx) => {
    const { rows } = await tx.execute<{ now: string }>(sql`SELECT ${sqlNow(now)} AS now`);
    const dbNow = new Date(rows[0]!.now);
    const cutoff = dailyCutoff(dbNow, timeZone, PURGE_HOUR);
    const [s] = await tx
      .select({ done: nodSettings.purgeDoneCutoff, leaseUntil: nodSettings.purgeLeaseUntil, enabled: nodSettings.purgeEnabled })
      .from(nodSettings)
      .where(eq(nodSettings.id, 1))
      .for("update");
    if (!s || (s.done && s.done.getTime() >= cutoff.getTime())) return { kind: "not-due" };
    if (s.leaseUntil && s.leaseUntil.getTime() > dbNow.getTime()) return { kind: "busy" };
    const lease = randomUUID();
    await tx.update(nodSettings).set({ purgeLease: lease, purgeLeaseUntil: new Date(dbNow.getTime() + LEASE_MS) }).where(eq(nodSettings.id, 1));
    return { kind: "claimed", lease, cutoff, enabled: s.enabled };
  });
}

/**
 * Adds one tick's deletes to its night's totals, whether or not this runner still holds the
 * lease: every row it deleted is gone for good, so it is always counted. Only the lease holder
 * closes the night (done stamp, lease cleared) and writes the night's log row. A runner whose
 * night was already closed by another, logs its own deletes in a row of their own, since that
 * night's row is already written without them.
 */
async function record(db: Db, c: Extract<Claim, { kind: "claimed" }>, tick: PurgeCounts, finished: boolean): Promise<PurgeRunResult> {
  const night = c.cutoff.toISOString();
  return db.transaction(async (tx) => {
    const [s] = await tx
      .select({ lease: nodSettings.purgeLease, done: nodSettings.purgeDoneCutoff, result: nodSettings.purgeResult })
      .from(nodSettings)
      .where(eq(nodSettings.id, 1))
      .for("update");
    const stored = (s?.result as PurgeRunResult | null) ?? null;
    const sameNight = stored?.cutoff === night;
    const laterNight = stored !== null && !sameNight && stored.cutoff > night;
    const ours = s?.lease === c.lease;
    const removed = (x: PurgeCounts) => Object.values(x).some((n) => n > 0);
    const result: PurgeRunResult = {
      cutoff: night,
      counts: addCounts(sameNight ? stored!.counts : NO_COUNTS, tick),
      finished: ours ? finished : sameNight ? stored!.finished : false,
      enabled: ours || !sameNight ? c.enabled : stored!.enabled,
    };
    if (ours) {
      await tx
        .update(nodSettings)
        .set({ purgeResult: result, purgeLease: null, purgeLeaseUntil: null, ...(finished ? { purgeDoneCutoff: c.cutoff } : {}), updatedAt: sql`now()` })
        .where(eq(nodSettings.id, 1));
      if (finished && removed(result.counts)) await writeOpsLog(tx, PURGE_ACTOR, "purge-ran", describeCounts(result.counts));
      return result;
    }
    if (!laterNight) await tx.update(nodSettings).set({ purgeResult: result, updatedAt: sql`now()` }).where(eq(nodSettings.id, 1));
    const nightClosed = laterNight || (s?.done != null && s.done.getTime() >= c.cutoff.getTime());
    if (nightClosed && removed(tick)) await writeOpsLog(tx, PURGE_ACTOR, "purge-ran", describeCounts(tick));
    return result;
  });
}

/**
 * The nightly purge (03:00 BC). Link housekeeping runs every night; subscribers and request
 * links only while the switch is on. A night that runs out of budget is picked up by the next
 * tick and its counts add up, as do those of a tick that failed or lost its lease. The
 * operations log gets one row when a night that removed anything finishes (plus one for any
 * deletes that land after that).
 */
export async function runPurgeIfDue(
  db: Db,
  timeZone: string,
  opts: { now?: TestClock; budgetMs?: number; maxSubscribers?: number } = {},
): Promise<{ ran: boolean; result?: PurgeRunResult }> {
  const c = await claim(db, timeZone, opts.now);
  if (c.kind !== "claimed") return { ran: false };
  const tick = { ...NO_COUNTS };
  let finished: boolean;
  try {
    finished = await purgeInto(
      db,
      { enabled: c.enabled, deadline: Date.now() + (opts.budgetMs ?? RUN_BUDGET_MS), maxSubscribers: opts.maxSubscribers ?? RUN_MAX_SUBSCRIBERS, now: opts.now },
      tick,
    );
  } catch (e) {
    // What was deleted before the failure is recorded (and the lease freed) before rethrowing.
    try {
      await record(db, c, tick, false);
    } catch (r) {
      console.error(`[nod] purge could not record a failed run: ${safeErrorLabel(r)}`);
    }
    throw e;
  }
  return { ran: true, result: await record(db, c, tick, finished) };
}

/** The Operations switch. Turning it on records what it would remove at that moment. */
export async function setPurgeEnabled(db: Db, enabled: boolean, actor: string, now?: TestClock): Promise<{ changed: boolean }> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .update(nodSettings)
      .set({ purgeEnabled: enabled, updatedAt: sql`now()` })
      .where(and(eq(nodSettings.id, 1), ne(nodSettings.purgeEnabled, enabled)))
      .returning({ id: nodSettings.id });
    if (!row) return { changed: false };
    const detail = enabled ? `would remove now: ${describeCounts(await previewPurge(tx, now))}` : "";
    await writeOpsLog(tx, actor, enabled ? "purge-enabled" : "purge-disabled", detail);
    return { changed: true };
  });
}

export interface PurgeStatus {
  enabled: boolean;
  preview: PurgeCounts;
  lastRun: PurgeRunResult | null;
  /** The next 03:00 BC after now. */
  nextRunAt: string;
}

export async function getPurgeStatus(db: DbOrTx, timeZone: string, now?: TestClock): Promise<PurgeStatus> {
  const { rows } = await db.execute<{ now: string }>(sql`SELECT ${sqlNow(now)} AS now`);
  const dbNow = new Date(rows[0]!.now);
  const today = todaysCutoff(dbNow, timeZone, PURGE_HOUR);
  const next = today.getTime() > dbNow.getTime() ? today : todaysCutoff(new Date(dbNow.getTime() + DAY_MS), timeZone, PURGE_HOUR);
  const [s] = await db.select({ enabled: nodSettings.purgeEnabled, result: nodSettings.purgeResult }).from(nodSettings).where(eq(nodSettings.id, 1));
  return {
    enabled: s?.enabled ?? false,
    preview: await previewPurge(db, now),
    lastRun: (s?.result as PurgeRunResult | null) ?? null,
    nextRunAt: next.toISOString(),
  };
}

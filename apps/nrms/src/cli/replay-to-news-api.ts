/**
 * Phase 3e cutover (spec §8 safety point 3): `npm run nrms:replay-to-news-api -- --confirm`
 * re-sends every already-published, live release to the News API as `release.updated` with
 * `notify: false`, through the normal outbox (delivery by the usual dispatcher) -- exactly the
 * record-building the publisher's own correction path uses (publisher.ts's `processOne`), minus
 * the log entry and the frozen `release_publications` copy a real correction writes, since this
 * is a replay of existing data, not a new edit. A plain `release.updated` never emails anyone in
 * NoD -- pinned by a NoD test. Dry run by default; `--confirm` to actually enqueue.
 *
 * Re-review N2: like every republish, it carries the release's latest "Email the correction"
 * request already passed on (`last_email_again`), under the same correction number. A replay
 * event can overtake the event that first carried it, and NoD then drops that one as stale; the
 * replay event still brings the request. NoD acts on each correction number once
 * (items.corrections_sent), so a request NoD already acted on is never sent again.
 *
 * Ordering: the dispatcher delivers oldest first, so a live publish made while the replay's
 * events are still being delivered waits behind them. Run it after legacy's publisher is off and
 * let its deliveries finish before release-holds (docs/deploy/siteground.md, "Cutover order").
 * Run with EVENT_SUBSCRIBERS naming `news-api` and `nod` for release.updated, as a republish goes.
 *
 * I4: each release is replayed inside its own savepoint (a nested `tx.transaction`), so one bad
 * release (e.g. its current content now builds an oversized envelope -- `MAX_EVENT_BYTES`)
 * never rolls back the rest of its batch. Failures are collected (key + a short, redacted
 * reason -- never the raw driver message's `params:` line) and the run keeps going.
 */
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";
import { parseEnv } from "@gcpe/config";
import { createDb, type Db } from "@gcpe/db-kit";
import { enqueueEvent, parseSubscribers, subscribersFor, type SubscriberConfig } from "@gcpe/events";
import { newsReleases, type SentEmailAgain } from "../db/schema";
import { stripParamsLines } from "../import/redact";
import { toEvent, trackEmailAgain } from "../publisher";
import { toReleaseRecord } from "../releases/record";
import { lastCorrection, loadView, NOD_SUBSCRIBER } from "../releases/store";

const BATCH_SIZE = 200;
const LIVE = and(eq(newsReleases.status, "published"), eq(newsReleases.live, true));

interface ReplayCandidate {
  id: string;
  key: string | null;
  last: SentEmailAgain | null;
}

async function loadCandidates(db: Db): Promise<ReplayCandidate[]> {
  return db.select({ id: newsReleases.id, key: newsReleases.key, last: newsReleases.lastEmailAgain }).from(newsReleases).where(LIVE).orderBy(asc(newsReleases.id));
}

/**
 * Review N5: the releases whose replay event will carry an Email the correction request that News
 * On Demand hasn't confirmed getting (the release's own "did NoD get it" state isn't "delivered"),
 * when NoD gets the replay at all. NoD sends that corrected copy when the replay reaches it.
 */
async function unconfirmedCorrections(db: Db, candidates: ReplayCandidate[], subscribers: SubscriberConfig[]): Promise<string[]> {
  if (!subscribersFor("release.updated", subscribers).some((s) => s.name === NOD_SUBSCRIBER)) return [];
  const out: string[] = [];
  for (const c of candidates) {
    if (c.last && (await lastCorrection(db, c.last)).state !== "delivered") out.push(c.key ?? c.id);
  }
  return out;
}

export interface ReplayOptions {
  confirm: boolean;
  subscribers: SubscriberConfig[];
  /** PUBLIC_FILES_BASE, exactly as the publisher gets it (apps/nrms/src/start.ts). */
  filesBase?: string;
  /** Test hook: stands in for "now" at every enqueued record's `timestamp`. */
  now?: () => Date;
  /** Test hook: runs just before each release is replayed (by key), outside its savepoint. */
  beforeRelease?: (key: string) => Promise<void>;
}

export interface ReplayFailure {
  key: string;
  reason: string;
}

export interface ReplayResult {
  confirmed: boolean;
  count: number;
  keys: string[];
  /** I4: releases that failed to replay (key + a short, redacted reason) -- empty on a dry run
   * or when every release replayed cleanly. */
  failures: ReplayFailure[];
  /** Review N2: releases no longer published and live by their turn (unpublished or being
   * corrected meanwhile): nothing sent for them. Empty on a dry run. */
  skipped: string[];
  /** Review N5: releases whose event carries a correction request NoD hasn't confirmed getting. */
  unconfirmedCorrections: string[];
}

/**
 * Dry run: counts and lists the candidates, enqueues nothing -- no transaction is even opened.
 * Confirmed: replays each candidate's current content as a `release.updated`, batched 200
 * releases per transaction so one run of a large catalogue never holds one giant transaction.
 * I4: each release gets its own savepoint inside the batch, so one failing release is recorded
 * and skipped rather than rolling back every other release already enqueued in its batch.
 */
export async function replayToNewsApi(db: Db, opts: ReplayOptions): Promise<ReplayResult> {
  const candidates = await loadCandidates(db);
  const keys = candidates.map((c) => c.key ?? c.id);
  // Judged before anything is enqueued, so the replay's own events don't change the answer.
  const unconfirmed = await unconfirmedCorrections(db, candidates, opts.subscribers);
  if (!opts.confirm) return { confirmed: false, count: candidates.length, keys, failures: [], skipped: [], unconfirmedCorrections: unconfirmed };

  const nowIso = (opts.now ? opts.now() : new Date()).toISOString();
  const failures: ReplayFailure[] = [];
  const skipped: string[] = [];
  for (let i = 0; i < candidates.length; i += BATCH_SIZE) {
    const batch = candidates.slice(i, i + BATCH_SIZE);
    await db.transaction(async (tx) => {
      for (const c of batch) {
        try {
          await opts.beforeRelease?.(c.key ?? c.id);
          await tx.transaction(async (savepoint) => {
            // Locked and re-checked, so a publish or unpublish of this release meanwhile can't
            // interleave with the replay (the publisher claims releases FOR UPDATE too).
            const [row] = await savepoint.select({ last: newsReleases.lastEmailAgain }).from(newsReleases).where(and(eq(newsReleases.id, c.id), LIVE)).for("update");
            const view = row && (await loadView(savepoint, c.id));
            if (!row || !view || !view.releasedAt) return void skipped.push(c.key ?? c.id); // releasedAt: defensive, published+live has one
            const record = toReleaseRecord(view, { publishDate: view.releasedAt, timestamp: nowIso }, { filesBase: opts.filesBase });
            // N2: the release's latest "Email the correction" request rides along, as on every
            // republish (publisher.ts takeEmailAgain), so a replay event that overtakes the one
            // that first carried it can't lose it. Same correction number: NoD acts on it once.
            const extra = row.last ? { emailAgain: toEvent(row.last) } : {};
            const event = await enqueueEvent(savepoint, { type: "release.updated", source: "nrms", aggregateId: record.key, data: { ...record, notify: false, ...extra } }, opts.subscribers);
            if (row.last) await trackEmailAgain(savepoint, c.id, row.last, event.id);
          });
        } catch (e) {
          failures.push({ key: c.key ?? c.id, reason: stripParamsLines(e instanceof Error ? e.message : String(e)) });
        }
      }
    });
  }
  return { confirmed: true, count: candidates.length, keys, failures, skipped, unconfirmedCorrections: unconfirmed };
}

export function printResult(result: ReplayResult, log: (s: string) => void = console.log): void {
  const corrections = () => {
    if (result.unconfirmedCorrections.length === 0) return;
    log(
      `${result.unconfirmedCorrections.length} release(s) will carry an Email the correction request News On Demand hasn't confirmed getting; News On Demand sends that corrected copy when this replay reaches it:`,
    );
    for (const key of result.unconfirmedCorrections) log(`  ${key}`);
  };
  if (!result.confirmed) {
    log(`${result.count} published, live release(s) would be replayed:`);
    for (const key of result.keys) log(`  ${key}`);
    corrections();
    log("Dry run: nothing enqueued. Re-run with --confirm to replay.");
    return;
  }
  const ok = result.count - result.failures.length - result.skipped.length;
  log(`Replayed ${ok} of ${result.count} release(s) to the News API as release.updated (notify: false).`);
  if (result.skipped.length > 0) {
    log(`${result.skipped.length} release(s) skipped: unpublished or changed while the replay ran (nothing sent for them):`);
    for (const key of result.skipped) log(`  ${key}`);
  }
  if (result.failures.length > 0) {
    log(`${result.failures.length} release(s) failed to replay:`);
    for (const f of result.failures) log(`  ${f.key}: ${f.reason}`);
  }
  corrections();
}

async function main(): Promise<void> {
  const env = parseEnv(z.object({ DATABASE_URL: z.string().url(), EVENT_SUBSCRIBERS: z.string().optional(), PUBLIC_FILES_BASE: z.string().optional() }));
  const confirm = process.argv.slice(2).includes("--confirm");
  const { db, pool } = createDb(env.DATABASE_URL);
  try {
    const result = await replayToNewsApi(db, { confirm, subscribers: parseSubscribers(env.EVENT_SUBSCRIBERS), filesBase: env.PUBLIC_FILES_BASE });
    printResult(result);
    // I4: any per-release failure makes the whole run exit non-zero, even though it kept going.
    if (result.failures.length > 0) process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

// M1: see release-holds.ts's matching guard for why this isn't the naive `file://${process.argv[1]}` comparison.
if (pathToFileURL(realpathSync(process.argv[1]!)).href === import.meta.url) {
  await main();
}

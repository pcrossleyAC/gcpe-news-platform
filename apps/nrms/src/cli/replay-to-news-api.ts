/**
 * Phase 3e cutover (spec §8 safety point 3): `npm run nrms:replay-to-news-api -- --confirm`
 * re-sends every already-published, live release to the News API as `release.updated` with
 * `notify: false`, through the normal outbox (delivery by the usual dispatcher) -- exactly the
 * record-building the publisher's own correction path uses (publisher.ts's `processOne`), minus
 * the log entry and the frozen `release_publications` copy a real correction writes, since this
 * is a replay of existing data, not a new edit. NoD only reacts to `release.published` from
 * `nrms` (apps/nod/src/app.ts:32), so this never emails a subscriber -- pinned by a NoD test.
 * Dry run by default; `--confirm` to actually enqueue.
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
import { enqueueEvent, parseSubscribers, type SubscriberConfig } from "@gcpe/events";
import { newsReleases } from "../db/schema";
import { stripParamsLines } from "../import/redact";
import { toReleaseRecord } from "../releases/record";
import { loadView } from "../releases/store";

const BATCH_SIZE = 200;
const LIVE = and(eq(newsReleases.status, "published"), eq(newsReleases.live, true));

interface ReplayCandidate {
  id: string;
  key: string | null;
}

async function loadCandidates(db: Db): Promise<ReplayCandidate[]> {
  return db.select({ id: newsReleases.id, key: newsReleases.key }).from(newsReleases).where(LIVE).orderBy(asc(newsReleases.id));
}

export interface ReplayOptions {
  confirm: boolean;
  subscribers: SubscriberConfig[];
  /** PUBLIC_FILES_BASE, exactly as the publisher gets it (apps/nrms/src/start.ts). */
  filesBase?: string;
  /** Test hook: stands in for "now" at every enqueued record's `timestamp`. */
  now?: () => Date;
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
  if (!opts.confirm) return { confirmed: false, count: candidates.length, keys, failures: [] };

  const nowIso = (opts.now ? opts.now() : new Date()).toISOString();
  const failures: ReplayFailure[] = [];
  for (let i = 0; i < candidates.length; i += BATCH_SIZE) {
    const batch = candidates.slice(i, i + BATCH_SIZE);
    await db.transaction(async (tx) => {
      for (const c of batch) {
        try {
          await tx.transaction(async (savepoint) => {
            const view = await loadView(savepoint, c.id);
            if (!view || !view.releasedAt) return; // defensive: shouldn't happen for published+live
            const record = toReleaseRecord(view, { publishDate: view.releasedAt, timestamp: nowIso }, { filesBase: opts.filesBase });
            await enqueueEvent(savepoint, { type: "release.updated", source: "nrms", aggregateId: record.key, data: { ...record, notify: false } }, opts.subscribers);
          });
        } catch (e) {
          failures.push({ key: c.key ?? c.id, reason: stripParamsLines(e instanceof Error ? e.message : String(e)) });
        }
      }
    });
  }
  return { confirmed: true, count: candidates.length, keys, failures };
}

export function printResult(result: ReplayResult, log: (s: string) => void = console.log): void {
  if (!result.confirmed) {
    log(`${result.count} published, live release(s) would be replayed:`);
    for (const key of result.keys) log(`  ${key}`);
    log("Dry run: nothing enqueued. Re-run with --confirm to replay.");
    return;
  }
  const ok = result.count - result.failures.length;
  log(`Replayed ${ok} of ${result.count} release(s) to the News API as release.updated (notify: false).`);
  if (result.failures.length > 0) {
    log(`${result.failures.length} release(s) failed to replay:`);
    for (const f of result.failures) log(`  ${f.key}: ${f.reason}`);
  }
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

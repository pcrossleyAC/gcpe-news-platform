import { and, eq, isNotNull, sql } from "drizzle-orm";
import type { Db } from "@gcpe/db-kit";
import { backoffMs } from "@gcpe/events";
import { DistributionError, type DistributionClient, type MessageRequest } from "./distribution-client";
import { deliveries, sendJobs, subscribers } from "./db/schema";

/** Distribution refuses a request with more than 20,000 recipients (P2-R15): a release that
 * targets more subscribers than this is sent as several requests instead of one. Exported so
 * tests can shrink it (and so any other caller sizing a request knows the real limit). */
export const MAX_RECIPIENTS_PER_CHUNK = 20_000;

const DEFAULT_BATCH_SIZE = 10;
const DEFAULT_MAX_AGE_MS = 24 * 3_600_000;
// Matches distribution-client.ts's DEFAULT_DISTRIBUTION_TIMEOUT_MS: the worst-case time a
// single chunk's request can take, used to size this job's claim lock (see claimOneJob).
const DEFAULT_PER_CHUNK_MS = 30_000;
const LOCK_MARGIN_MS = 30_000;

export interface SendJobsOptions {
  db: Db;
  distribution: DistributionClient;
  /** Base URL for the manage/unsubscribe page; each recipient's substitution is
   * `${manageUrl}?token=${encodeURIComponent(subscriber.manageToken)}`. */
  manageUrl: string;
  /** Clock override for tests; defaults to the wall clock. */
  now?: () => Date;
  /** Max number of send_jobs claimed (one at a time, see claimOneJob) per call. */
  batchSize?: number;
  maxAgeMs?: number;
  /** Override for {@link MAX_RECIPIENTS_PER_CHUNK}, for tests. */
  chunkSize?: number;
  /** Override for the per-chunk request timeout used to size the claim lock, for tests.
   * Should match the distribution client's own `timeoutMs`. */
  perChunkMs?: number;
}

type ClaimedJobRow = {
  id: string;
  release_key: string;
  subject: string | null;
  html: string | null;
  text: string | null;
  attempts: number;
  created_at: Date;
};

/**
 * Claims exactly one due job under an ownership-token lock (`locked_until`), same pattern as
 * apps/distribution/src/sender.ts and packages/events/src/dispatcher.ts. One job at a time —
 * never a whole batch in one claim — because a job's processing time depends on how many
 * chunks *that job* needs, which isn't known until after it's claimed (see sendDueJobs): a
 * multi-row claim would have to size its lock for the worst case across the whole batch,
 * which is unbounded.
 */
async function claimOneJob(db: Db, now: Date, lockUntil: Date): Promise<ClaimedJobRow | undefined> {
  const claimed = await db.execute<ClaimedJobRow>(sql`
    UPDATE send_jobs
       SET locked_until = ${lockUntil}
     WHERE id = (
       SELECT id FROM send_jobs
        WHERE status = 'pending'
          AND next_attempt_at <= ${now}
          AND (locked_until IS NULL OR locked_until < ${now})
        ORDER BY next_attempt_at, id
        LIMIT 1
        FOR UPDATE SKIP LOCKED
     )
    RETURNING id, release_key, subject, html, text, attempts, created_at`);
  return claimed.rows[0];
}

/** Extends (or shrinks) this call's lock on a job it still owns, re-asserting ownership by
 * requiring the lock to still equal the value this call's own claim set. Returns false if
 * ownership was lost in between (shouldn't happen under normal operation since nothing else
 * can touch a 'pending' row holding our lock, but guarded anyway — ownership checks on every
 * terminal write are the house style, see sender.ts). */
async function extendLock(db: Db, jobId: string, currentLockUntil: Date, newLockUntil: Date): Promise<boolean> {
  const res = await db.execute<{ id: string }>(sql`
    UPDATE send_jobs SET locked_until = ${newLockUntil}
     WHERE id = ${jobId} AND locked_until = ${currentLockUntil} AND status = 'pending'
    RETURNING id`);
  return res.rows.length > 0;
}

/** Releases a lock this call still owns without touching status/attempts — used when bailing
 * out of a job before reaching a terminal outcome (e.g. the recipient query itself failed),
 * so another run can retry it immediately instead of waiting out the lock. */
async function releaseLock(db: Db, jobId: string, lockUntil: Date): Promise<void> {
  await db
    .update(sendJobs)
    .set({ lockedUntil: null })
    .where(and(eq(sendJobs.id, jobId), eq(sendJobs.lockedUntil, lockUntil), eq(sendJobs.status, "pending")));
}

interface Recipient {
  email: string;
  manageToken: string;
}

/** Verified subscribers who received this release, ordered by subscriber id so a retry (which
 * restarts chunking from scratch, see sendAllChunks) rebuilds byte-identical chunks. */
async function fetchRecipients(db: Db, releaseKey: string): Promise<Recipient[]> {
  return db
    .select({ email: subscribers.email, manageToken: subscribers.manageToken })
    .from(deliveries)
    .innerJoin(subscribers, eq(subscribers.id, deliveries.subscriberId))
    .where(and(eq(deliveries.releaseKey, releaseKey), isNotNull(subscribers.verifiedAt)))
    .orderBy(subscribers.id);
}

function buildMessageRequest(job: ClaimedJobRow, chunk: Recipient[], chunkIndex: number, manageUrl: string): MessageRequest {
  return {
    priority: "immediate",
    idempotencyKey: `${job.id}:${chunkIndex}`,
    subject: job.subject ?? "",
    html: job.html ?? "",
    text: job.text ?? undefined,
    headers: { "List-Unsubscribe": "<{{manageUrl}}>", "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" },
    recipients: chunk.map((r) => ({
      email: r.email,
      substitutions: { manageUrl: `${manageUrl}?token=${encodeURIComponent(r.manageToken)}` },
    })),
  };
}

/**
 * Sends every chunk for a job, in order, starting at chunk 0 — every call, including a retry
 * after a prior attempt failed partway through. That's deliberate (P2-R15): Distribution
 * dedupes a chunk whose idempotencyKey it already accepted (200 instead of 202), so resending
 * a chunk that already succeeded is a cheap no-op, while resuming from "the chunk that failed
 * last time" would require persisting progress this module has no need for otherwise. Throws
 * (propagating whatever distribution.send threw) on the first chunk that doesn't succeed.
 */
async function sendAllChunks(distribution: DistributionClient, job: ClaimedJobRow, recipients: Recipient[], chunkSize: number, manageUrl: string): Promise<string[]> {
  const batchIds: string[] = [];
  for (let i = 0; i * chunkSize < recipients.length; i++) {
    const chunk = recipients.slice(i * chunkSize, (i + 1) * chunkSize);
    const { batchId } = await distribution.send(buildMessageRequest(job, chunk, i, manageUrl));
    batchIds.push(batchId);
  }
  return batchIds;
}

export async function sendDueJobs(opts: SendJobsOptions): Promise<{ sent: number; retried: number; failed: number }> {
  const clock = opts.now ?? (() => new Date());
  const batchSize = opts.batchSize ?? DEFAULT_BATCH_SIZE;
  const maxAgeMs = opts.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
  const chunkSize = opts.chunkSize ?? MAX_RECIPIENTS_PER_CHUNK;
  const perChunkMs = opts.perChunkMs ?? DEFAULT_PER_CHUNK_MS;

  const result = { sent: 0, retried: 0, failed: 0 };

  for (let i = 0; i < batchSize; i++) {
    const now = clock();
    // Sized just to outlive the recipient lookup + the lock-extend below — real sizing (based
    // on this job's own chunk count) happens once that's known, via extendLock.
    const initialLockUntil = new Date(now.getTime() + perChunkMs + LOCK_MARGIN_MS);
    const job = await claimOneJob(opts.db, now, initialLockUntil);
    if (!job) break;

    let recipients: Recipient[];
    let lockUntil: Date;
    try {
      recipients = await fetchRecipients(opts.db, job.release_key);
      const chunkCount = Math.max(1, Math.ceil(recipients.length / chunkSize));
      lockUntil = new Date(now.getTime() + chunkCount * perChunkMs + LOCK_MARGIN_MS);
      const reowned = await extendLock(opts.db, job.id, initialLockUntil, lockUntil);
      if (!reowned) continue; // lost ownership somehow; leave it for the next run
    } catch (e) {
      await releaseLock(opts.db, job.id, initialLockUntil);
      throw e;
    }

    const where = and(eq(sendJobs.id, job.id), eq(sendJobs.status, "pending"), eq(sendJobs.lockedUntil, lockUntil));

    let error: DistributionError | undefined;
    let batchIds: string[] = [];
    try {
      batchIds = await sendAllChunks(opts.distribution, job, recipients, chunkSize, opts.manageUrl);
    } catch (e) {
      error = e instanceof DistributionError ? e : new DistributionError(e instanceof Error ? e.message : String(e), false);
    }

    const finishedAt = clock();
    if (!error) {
      const res = await opts.db.update(sendJobs).set({ status: "sent", batchIds, lockedUntil: null, lastError: null }).where(where);
      if (res.rowCount) result.sent++;
      continue;
    }

    const attempts = job.attempts + 1;
    // job.created_at comes back from the raw db.execute() above as whatever the driver gives
    // a timestamptz (a string, not a Date) — unlike a drizzle query builder result.
    const age = finishedAt.getTime() - new Date(job.created_at).getTime();
    if (!error.retryable || age >= maxAgeMs) {
      const res = await opts.db.update(sendJobs).set({ status: "failed", attempts, lockedUntil: null, lastError: error.message }).where(where);
      if (res.rowCount) result.failed++;
    } else {
      const res = await opts.db
        .update(sendJobs)
        .set({ attempts, nextAttemptAt: new Date(finishedAt.getTime() + backoffMs(attempts)), lockedUntil: null, lastError: error.message })
        .where(where);
      if (res.rowCount) result.retried++;
    }
  }

  return result;
}

export function startJobSender(opts: SendJobsOptions & { intervalMs?: number }): () => Promise<void> {
  let stopped = false;
  let running: Promise<unknown> | null = null;
  const timer = setInterval(() => {
    if (stopped || running) return;
    running = sendDueJobs(opts)
      .catch((e) => console.error("[nod] send failed", e))
      .finally(() => {
        running = null;
      });
  }, opts.intervalMs ?? 5000);
  return async () => {
    stopped = true;
    clearInterval(timer);
    await running;
  };
}

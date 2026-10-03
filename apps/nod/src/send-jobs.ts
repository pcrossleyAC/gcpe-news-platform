import { and, eq, isNotNull, isNull, sql } from "drizzle-orm";
import type { Db } from "@gcpe/db-kit";
import { backoffMs } from "@gcpe/events";
import { DistributionError, type DistributionClient, type MessageRequest } from "./distribution-client";
import { deliveries, sendJobs, subscribers } from "./db/schema";

/** Distribution refuses a request with more than 20,000 recipients (P2-R15): a release that
 * targets more subscribers than this is sent as several requests instead of one. Exported so
 * tests can shrink it (and so any other caller sizing a request knows the real limit). */
export const MAX_RECIPIENTS_PER_CHUNK = 20_000;

/** M3: Distribution's own body limit is 10mb (apps/distribution/src/app.ts), but a chunk sized
 * only by recipient *count* (MAX_RECIPIENTS_PER_CHUNK) can still produce a request whose JSON
 * payload is large if recipients carry sizeable per-recipient substitutions — so a chunk is
 * also split further whenever its JSON payload would exceed this many bytes, independent of
 * MAX_RECIPIENTS_PER_CHUNK. Exported so tests can shrink it. */
export const MAX_CHUNK_BYTES = 8 * 1024 * 1024;

const DEFAULT_BATCH_SIZE = 10;
const DEFAULT_MAX_AGE_MS = 24 * 3_600_000;
// Matches distribution-client.ts's DEFAULT_DISTRIBUTION_TIMEOUT_MS: the worst-case time a
// single chunk's request (or a single getToken call) can take, used to size this job's claim
// lock (see claimOneJob).
const DEFAULT_PER_CHUNK_MS = 30_000;
const LOCK_MARGIN_MS = 30_000;

export interface SendJobsOptions {
  db: Db;
  distribution: DistributionClient;
  /** Base URL for the manage/unsubscribe page; each recipient's substitution is this URL with
   * a `token` query parameter set to their `manageToken` (any existing query string on
   * `manageUrl` is preserved — see manageLinkFor). */
  manageUrl: string;
  /** Clock override for tests; defaults to the wall clock. */
  now?: () => Date;
  /** Max number of send_jobs claimed (one at a time, see claimOneJob) per call. */
  batchSize?: number;
  maxAgeMs?: number;
  /** Override for {@link MAX_RECIPIENTS_PER_CHUNK}, for tests. Only takes effect the first
   * time a given release's chunks are assigned (see ensureChunksAssigned) — it has no effect
   * on a release whose deliveries were already chunked under a different size. */
  chunkSize?: number;
  /** Override for the per-chunk/per-token-fetch timeout used to size the claim lock, for
   * tests. Should match the distribution client's own `timeoutMs`. */
  perChunkMs?: number;
  /** Override for {@link MAX_CHUNK_BYTES}, for tests. */
  maxChunkBytes?: number;
}

type ClaimedJobRow = {
  id: string;
  release_key: string;
  subject: string | null;
  html: string | null;
  text: string | null;
  attempts: number;
  created_at: Date;
  chunks_assigned: boolean;
  batch_ids: Record<string, string>;
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
    RETURNING id, release_key, subject, html, text, attempts, created_at, chunks_assigned, batch_ids`);
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

/**
 * P2-R16: freezes which subscribers belong to which chunk, once, the first time a release's
 * job is attempted — so a subscriber deleted (cascades the delivery row away) or added
 * (inserted after this ran) between attempts can't shift any *other* recipient's chunk
 * boundary.
 *
 * P2-R18: the chunk_index assignment and the `chunks_assigned` flag write happen inside one
 * transaction, re-checking `chunks_assigned = false` once inside it before doing anything.
 * Without that, the two were separate autocommitted statements — a crash between them could
 * leave chunk_index assigned but the flag still false, so the *next* attempt would see
 * "not assigned yet", re-run the same UPDATE, and its `WHERE chunk_index IS NULL` subquery
 * would now only match rows that arrived after the crash (everything else already has a
 * non-NULL chunk_index). `row_number()` over just that smaller, late-arriving set restarts at
 * 1, numbering them into chunk 0 — which, from the first (never-flagged) run, may already be
 * full, silently growing it past chunkSize (at the real 20,000 limit, this is a terminal
 * Distribution 400, not just an oversight). Wrapping both writes in one transaction means a
 * crash anywhere in between rolls the entire assignment back, so a later attempt only ever
 * sees "nothing assigned" (and (re-)assigns everything, including any new arrivals, together
 * and contiguously) or "fully assigned" (and does nothing) — never the half-done state that
 * caused the overflow. `onBeforeFlagWrite` exists only so a test can force a failure between
 * the two writes and assert the whole thing rolled back; production call sites never pass it.
 */
export async function ensureChunksAssigned(db: Db, jobId: string, releaseKey: string, chunkSize: number, opts: { onBeforeFlagWrite?: () => void } = {}): Promise<void> {
  await db.transaction(async (tx) => {
    const [row] = await tx.select({ chunksAssigned: sendJobs.chunksAssigned }).from(sendJobs).where(eq(sendJobs.id, jobId));
    if (row?.chunksAssigned) return; // already fully assigned (and flagged) — nothing to do
    await tx.execute(sql`
      UPDATE deliveries SET chunk_index = sub.idx
        FROM (
          SELECT subscriber_id, ((row_number() OVER (ORDER BY subscriber_id) - 1) / ${chunkSize})::int AS idx
            FROM deliveries
           WHERE release_key = ${releaseKey} AND chunk_index IS NULL
        ) sub
       WHERE deliveries.release_key = ${releaseKey} AND deliveries.subscriber_id = sub.subscriber_id`);
    opts.onBeforeFlagWrite?.();
    await tx.update(sendJobs).set({ chunksAssigned: true }).where(and(eq(sendJobs.id, jobId), eq(sendJobs.chunksAssigned, false)));
  });
}

interface Recipient {
  email: string;
  manageToken: string;
}

/** Every verified subscriber with an assigned chunk for this release, grouped by that frozen
 * chunk_index (not recomputed from position — see ensureChunksAssigned). The query orders by
 * (chunk_index, subscriber id), so each chunk's own recipient order is deterministic too, and
 * the first time a given index is seen determines the resulting Map's iteration order —
 * ascending by chunk_index, with any index that ended up with zero verified recipients simply
 * absent (sendAllChunks never sends an empty request for it). */
async function fetchAssignedRecipients(db: Db, releaseKey: string): Promise<Map<number, Recipient[]>> {
  const rows = await db
    .select({ chunkIndex: deliveries.chunkIndex, email: subscribers.email, manageToken: subscribers.manageToken })
    .from(deliveries)
    .innerJoin(subscribers, eq(subscribers.id, deliveries.subscriberId))
    .where(and(eq(deliveries.releaseKey, releaseKey), isNotNull(subscribers.verifiedAt), isNotNull(deliveries.chunkIndex)))
    .orderBy(deliveries.chunkIndex, subscribers.id);

  const chunks = new Map<number, Recipient[]>();
  for (const row of rows) {
    const idx = row.chunkIndex!;
    const bucket = chunks.get(idx);
    if (bucket) bucket.push({ email: row.email, manageToken: row.manageToken });
    else chunks.set(idx, [{ email: row.email, manageToken: row.manageToken }]);
  }
  return chunks;
}

/** Verified deliveries for this release whose *delivery row itself* was inserted after
 * chunking was frozen — chunk_index is still NULL, so they're not part of this (or any) job's
 * chunks (P2-R18: this is not the same thing as "became verified after freezing" —
 * ensureChunksAssigned doesn't filter on verified_at at all, so a subscriber who becomes
 * verified later still has whatever chunk_index their delivery row got assigned at freeze
 * time, and is picked up by fetchAssignedRecipients on this job's next attempt. The one case
 * where a late-verified subscriber is never mailed is if their chunk was already sent and
 * accepted in an earlier attempt and the job has since reached a terminal state — by design,
 * not a bug: freezing trades "catch every last-second verification" for stable, safe-to-retry
 * chunk membership). */
async function countLateDeliveries(db: Db, releaseKey: string): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(deliveries)
    .innerJoin(subscribers, eq(subscribers.id, deliveries.subscriberId))
    .where(and(eq(deliveries.releaseKey, releaseKey), isNotNull(subscribers.verifiedAt), isNull(deliveries.chunkIndex)));
  return row?.count ?? 0;
}

/** Builds the per-recipient manage/unsubscribe link from `manageUrl` plus a `token` query
 * parameter, preserving any query string `manageUrl` already has (P2-R16) — a naive
 * `${manageUrl}?token=...` would instead produce a second, malformed `?` if `manageUrl` ever
 * carries its own query. */
function manageLinkFor(manageUrl: string, token: string): string {
  const url = new URL(manageUrl);
  url.searchParams.set("token", token);
  return url.toString();
}

/** `key` is the chunk's own idempotency suffix — normally just its `chunk_index` (as a
 * string), or `<chunk_index>.<part>` when {@link splitChunkByBytes} had to split it further. */
function buildMessageRequest(job: ClaimedJobRow, chunk: Recipient[], key: string, manageUrl: string): MessageRequest {
  return {
    priority: "immediate",
    idempotencyKey: `${job.id}:${key}`,
    subject: job.subject ?? "",
    html: job.html ?? "",
    text: job.text ?? undefined,
    headers: { "List-Unsubscribe": "<{{manageUrl}}>", "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" },
    recipients: chunk.map((r) => ({
      email: r.email,
      substitutions: { manageUrl: manageLinkFor(manageUrl, r.manageToken) },
    })),
  };
}

function requestByteSize(req: MessageRequest): number {
  return Buffer.byteLength(JSON.stringify(req), "utf8");
}

/**
 * M3: a chunk sized only by recipient count (MAX_RECIPIENTS_PER_CHUNK) can still produce a
 * request whose JSON payload is too big if recipients carry sizeable per-recipient
 * substitutions — so split it further whenever its request would exceed `maxBytes`. Recipients
 * are assumed roughly uniform in size (a manage link built the same way for everyone), so the
 * first candidate split's measured size is representative of the rest: `n` only grows until one
 * probe fits, rather than measuring every part. Each part keeps `chunkIndex`'s own identity in
 * its key (`<chunkIndex>` when not split at all, `<chunkIndex>.<part>` otherwise) so retries
 * address the same sub-parts (and the same Distribution idempotencyKey) every time.
 */
function splitChunkByBytes(job: ClaimedJobRow, recipients: Recipient[], chunkIndex: number, manageUrl: string, maxBytes: number): { key: string; request: MessageRequest }[] {
  let n = 1;
  while (n < recipients.length) {
    const size = Math.ceil(recipients.length / n);
    const probe = buildMessageRequest(job, recipients.slice(0, size), String(chunkIndex), manageUrl);
    if (requestByteSize(probe) <= maxBytes) break;
    n++;
  }
  if (n === 1) return [{ key: String(chunkIndex), request: buildMessageRequest(job, recipients, String(chunkIndex), manageUrl) }];

  const partSize = Math.ceil(recipients.length / n);
  const parts: { key: string; request: MessageRequest }[] = [];
  for (let i = 0, part = 0; i < recipients.length; i += partSize, part++) {
    const key = `${chunkIndex}.${part}`;
    parts.push({ key, request: buildMessageRequest(job, recipients.slice(i, i + partSize), key, manageUrl) });
  }
  return parts;
}

/**
 * Sends every chunk for a job, in ascending chunk_index order, starting from the first —
 * every call, including a retry after a prior attempt failed partway through. That's
 * deliberate (P2-R15): Distribution dedupes a chunk whose idempotencyKey it already accepted
 * (200 instead of 202), so resending a chunk that already succeeded is a cheap no-op. Never
 * throws: stops and returns whatever it already has (including a partial `batchIds`) plus the
 * `error` that stopped it, so the caller can persist accepted chunks even on a failed/retried
 * attempt (P2-R16).
 */
async function sendAllChunks(
  distribution: DistributionClient,
  job: ClaimedJobRow,
  chunks: Map<number, Recipient[]>,
  manageUrl: string,
  maxChunkBytes: number,
): Promise<{ batchIds: Record<string, string>; error?: DistributionError }> {
  const batchIds: Record<string, string> = {};
  for (const [chunkIndex, recipients] of chunks) {
    for (const { key, request } of splitChunkByBytes(job, recipients, chunkIndex, manageUrl, maxChunkBytes)) {
      try {
        const { batchId } = await distribution.send(request);
        batchIds[key] = batchId;
      } catch (e) {
        // P2-R16: any error here is treated as retryable (bounded below by maxAgeMs) unless
        // distribution-client.ts itself deliberately classified it otherwise — an *unexpected*
        // error (anything not already a DistributionError) must never permanently fail a job.
        const error = e instanceof DistributionError ? e : new DistributionError(e instanceof Error ? e.message : String(e), true);
        return { batchIds, error };
      }
    }
  }
  return { batchIds };
}

export async function sendDueJobs(opts: SendJobsOptions): Promise<{ sent: number; retried: number; failed: number }> {
  const clock = opts.now ?? (() => new Date());
  const batchSize = opts.batchSize ?? DEFAULT_BATCH_SIZE;
  const maxAgeMs = opts.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
  const chunkSize = opts.chunkSize ?? MAX_RECIPIENTS_PER_CHUNK;
  const perChunkMs = opts.perChunkMs ?? DEFAULT_PER_CHUNK_MS;
  const maxChunkBytes = opts.maxChunkBytes ?? MAX_CHUNK_BYTES;

  const result = { sent: 0, retried: 0, failed: 0 };

  for (let i = 0; i < batchSize; i++) {
    const now = clock();
    // Sized just to outlive assigning chunks + the recipient/late-delivery lookups + the
    // lock-extend below — real sizing (based on this job's own chunk count) happens once
    // that's known, via extendLock.
    const initialLockUntil = new Date(now.getTime() + perChunkMs + LOCK_MARGIN_MS);
    const job = await claimOneJob(opts.db, now, initialLockUntil);
    if (!job) break;

    let chunks: Map<number, Recipient[]>;
    let lockUntil: Date;
    try {
      if (!job.chunks_assigned) {
        await ensureChunksAssigned(opts.db, job.id, job.release_key, chunkSize);
      }
      const lateCount = await countLateDeliveries(opts.db, job.release_key);
      if (lateCount > 0) {
        console.log(`[nod] release ${job.release_key}: ${lateCount} delivery(ies) arrived after chunking was frozen and are not part of job ${job.id}`);
      }

      chunks = await fetchAssignedRecipients(opts.db, job.release_key);
      // chunks.size (every chunk this attempt will actually send) * perChunkMs (worst case
      // every one hits the request timeout) + perChunkMs once more (getToken's own timeout —
      // it can only block the whole attempt once, since a successful fetch is cached) + the
      // fixed margin.
      lockUntil = new Date(now.getTime() + chunks.size * perChunkMs + perChunkMs + LOCK_MARGIN_MS);
      const reowned = await extendLock(opts.db, job.id, initialLockUntil, lockUntil);
      if (!reowned) continue; // lost ownership somehow; leave it for the next run
    } catch (e) {
      await releaseLock(opts.db, job.id, initialLockUntil);
      throw e;
    }

    const where = and(eq(sendJobs.id, job.id), eq(sendJobs.status, "pending"), eq(sendJobs.lockedUntil, lockUntil));

    // No per-chunk ownership re-assert before each chunk send (unlike sender.ts's per-row
    // loop): chunk membership is frozen (ensureChunksAssigned) and every chunk's
    // idempotencyKey is stable across attempts, so even in the (already very unlikely) event
    // this call's lock were stolen mid-loop, a concurrent claimant would resend the exact same
    // chunks and Distribution would dedupe every one already accepted. The only write that
    // has to be ownership-checked is the terminal one below (`where`), which is.
    const { batchIds: newBatchIds, error } = await sendAllChunks(opts.distribution, job, chunks, opts.manageUrl, maxChunkBytes);
    // P2-R16: merge newly-accepted chunk ids into whatever this job already had recorded —
    // persisted below on every attempt, including one that ends in "failed" or "retried", so
    // a chunk accepted before a later chunk failed is never re-sent as if it were unknown.
    const batchIds = { ...job.batch_ids, ...newBatchIds };

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
      const res = await opts.db.update(sendJobs).set({ status: "failed", attempts, batchIds, lockedUntil: null, lastError: error.message }).where(where);
      // I5: a job going failed is otherwise silent — nothing else notices a release that
      // stopped mailing. Logged once, only when this call actually made the write (the
      // ownership-guarded `where` matched), not on every attempt that merely observes it.
      if (res.rowCount) {
        result.failed++;
        console.error(`[nod] job ${job.id} release ${job.release_key} failed: ${error.message}`);
      }
    } else {
      const res = await opts.db
        .update(sendJobs)
        .set({ attempts, batchIds, nextAttemptAt: new Date(finishedAt.getTime() + backoffMs(attempts)), lockedUntil: null, lastError: error.message })
        .where(where);
      if (res.rowCount) {
        result.retried++;
        console.warn(`[nod] job ${job.id} release ${job.release_key} retrying (attempt ${attempts}): ${error.message}`);
      }
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

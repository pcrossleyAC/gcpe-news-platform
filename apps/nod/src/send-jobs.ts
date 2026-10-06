import { and, eq, inArray, isNotNull, isNull, sql, type SQL } from "drizzle-orm";
import { ageMsOf, lockTokenOf, ownedPending, sqlInterval, sqlNow, sqlNowPlus, stopwatch, type Db, type LockToken, type TestClock } from "@gcpe/db-kit";
import { backoffMs } from "@gcpe/events";
import { DistributionError, type DistributionClient, type MessageRequest } from "./distribution-client";
import { deliveries, items, jobRecipients, nodSettings, sendJobs, subscribers } from "./db/schema";
import { recipientSubstitutions, type RecipientLinkOptions } from "./recipient-links";

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
  /** Per-recipient manage/unsubscribe link options (Task 3's recipient-links.ts). A fresh
   * manage link and the stable one-click unsubscribe URL are built for each active recipient
   * of a chunk part, just before that part is sent (see sendAllChunks). */
  links: RecipientLinkOptions;
  /** Test hook: when given, its value stands in for SQL `now()` in every statement this call
   * makes (claim, lock, backoff, age). Production omits it and the database's clock is used
   * throughout — see {@link sendDueJobs}. */
  now?: TestClock;
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
  item_key: string | null;
  priority: "immediate" | "digest" | "media" | "system";
  kind: string;
  subject: string | null;
  html: string | null;
  text: string | null;
  attempts: number;
  /** The job's age at claim time, by the database's clock. */
  age_ms: number;
  chunks_assigned: boolean;
  batch_ids: Record<string, string>;
  /** The exact locked_until this claim wrote — the job's ownership token. */
  lock_token: LockToken;
};

/**
 * Claims exactly one due job under an ownership-token lock (`locked_until`), same pattern as
 * apps/distribution/src/sender.ts and packages/events/src/dispatcher.ts. One job at a time —
 * never a whole batch in one claim — because a job's processing time depends on how many
 * chunks *that job* needs, which isn't known until after it's claimed (see sendDueJobs): a
 * multi-row claim would have to size its lock for the worst case across the whole batch,
 * which is unbounded.
 */
async function claimOneJob(db: Db, now: SQL, lockMs: number): Promise<ClaimedJobRow | undefined> {
  const claimed = await db.execute<ClaimedJobRow>(sql`
    UPDATE send_jobs
       SET locked_until = ${now} + ${sqlInterval(lockMs)}
     WHERE id = (
       SELECT id FROM send_jobs
        WHERE status = 'pending'
          AND next_attempt_at <= ${now}
          AND (locked_until IS NULL OR locked_until < ${now})
        ORDER BY next_attempt_at, id
        LIMIT 1
        FOR UPDATE SKIP LOCKED
     )
    RETURNING id, item_key, priority, kind, subject, html, text, attempts, ${ageMsOf(sql`created_at`, now)} AS age_ms, chunks_assigned, batch_ids,
              ${lockTokenOf(sql`locked_until`)} AS lock_token`);
  return claimed.rows[0];
}

/** Extends this call's lock on a job it still owns by `extraMs` (relative to the lock the
 * claim set, so the result is still "claim time + total budget" on the database's clock),
 * re-asserting ownership by requiring the lock to still equal the value this call's own claim
 * set. Returns the new ownership token, or undefined if ownership was lost in between
 * (shouldn't happen under normal operation since nothing else can touch a 'pending' row
 * holding our lock, but guarded anyway — ownership checks on every terminal write are the
 * house style, see sender.ts). */
async function extendLock(db: Db, jobId: string, token: LockToken, extraMs: number): Promise<LockToken | undefined> {
  const res = await db.execute<{ lock_token: LockToken }>(sql`
    UPDATE send_jobs SET locked_until = locked_until + ${sqlInterval(extraMs)}
     WHERE id = ${jobId} AND ${ownedPending(sendJobs, token)}
    RETURNING ${lockTokenOf(sql`locked_until`)} AS lock_token`);
  return res.rows[0]?.lock_token;
}

/** Releases a lock this call still owns without touching status/attempts — used when bailing
 * out of a job before reaching a terminal outcome (e.g. the recipient query itself failed),
 * so another run can retry it immediately instead of waiting out the lock. */
async function releaseLock(db: Db, jobId: string, token: LockToken): Promise<void> {
  await db
    .update(sendJobs)
    .set({ lockedUntil: null })
    .where(and(eq(sendJobs.id, jobId), ownedPending(sendJobs, token)));
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
export async function ensureChunksAssigned(db: Db, jobId: string, chunkSize: number, opts: { onBeforeFlagWrite?: () => void } = {}): Promise<void> {
  await db.transaction(async (tx) => {
    const [row] = await tx.select({ chunksAssigned: sendJobs.chunksAssigned }).from(sendJobs).where(eq(sendJobs.id, jobId));
    if (row?.chunksAssigned) return; // already fully assigned (and flagged) — nothing to do
    await tx.execute(sql`
      UPDATE job_recipients SET chunk_index = sub.idx
        FROM (
          SELECT subscriber_id, ((row_number() OVER (ORDER BY subscriber_id) - 1) / ${chunkSize})::int AS idx
            FROM job_recipients
           WHERE job_id = ${jobId} AND chunk_index IS NULL
        ) sub
       WHERE job_recipients.job_id = ${jobId} AND job_recipients.subscriber_id = sub.subscriber_id`);
    opts.onBeforeFlagWrite?.();
    await tx.update(sendJobs).set({ chunksAssigned: true }).where(and(eq(sendJobs.id, jobId), eq(sendJobs.chunksAssigned, false)));
  });
}

/** R3: a chunk's byte-split partition (how many parts, and which members fall in which part)
 * must be computed over this — the chunk's *frozen* membership, regardless of each member's
 * *current* active status — not over whatever happens to be active right now. Otherwise a
 * subscriber flipping inactive between attempt 1 and attempt 2 shrinks the recipient list
 * `splitChunkByBytes` sizes against, which can change the part count/boundaries and therefore
 * the idempotencyKey a given recipient's part is sent under — exactly the kind of instability
 * chunk_index freezing (ensureChunksAssigned) already exists to prevent, one level down.
 *
 * `subscriberId`/`unsubscribeVersion` feed {@link recipientSubstitutions} (Task 3) for this
 * member's per-recipient manage/unsubscribe links, built just before a part is actually sent. */
interface Member {
  subscriberId: string;
  email: string;
  unsubscribeVersion: number;
  active: boolean;
}

/** Every member of this job's frozen chunks (chunk_index IS NOT NULL — see
 * ensureChunksAssigned), grouped by chunk_index, *regardless of current active status* (R3:
 * the byte-split partition below must size itself against this frozen membership, not against
 * whichever subset happens to be active on any given attempt). The query orders by
 * (chunk_index, subscriber id), so each chunk's own member order — and therefore every part's
 * membership — is deterministic across attempts. Filtering to only-active happens later, at
 * send time, per part (see sendAllChunks). */
async function fetchAssignedMembers(db: Db, jobId: string): Promise<Map<number, Member[]>> {
  const rows = await db
    .select({
      chunkIndex: jobRecipients.chunkIndex,
      subscriberId: subscribers.id,
      email: subscribers.email,
      status: subscribers.status,
      unsubscribeVersion: subscribers.unsubscribeVersion,
    })
    .from(jobRecipients)
    .innerJoin(subscribers, eq(subscribers.id, jobRecipients.subscriberId))
    .where(and(eq(jobRecipients.jobId, jobId), isNotNull(jobRecipients.chunkIndex)))
    .orderBy(jobRecipients.chunkIndex, subscribers.id);

  const chunks = new Map<number, Member[]>();
  for (const row of rows) {
    const idx = row.chunkIndex!;
    const member: Member = {
      subscriberId: row.subscriberId,
      email: row.email,
      unsubscribeVersion: row.unsubscribeVersion,
      active: row.status === "active",
    };
    const bucket = chunks.get(idx);
    if (bucket) bucket.push(member);
    else chunks.set(idx, [member]);
  }
  return chunks;
}

/** Active-subscriber recipients of this job whose *job_recipients row itself* was inserted
 * after chunking was frozen — chunk_index is still NULL, so they're not part of this (or any)
 * attempt's chunks (P2-R18: this is not the same thing as "became active after freezing" —
 * ensureChunksAssigned doesn't filter on status at all, so a subscriber who becomes active
 * later still has whatever chunk_index their job_recipients row got assigned at freeze time,
 * and is picked up by fetchAssignedMembers on this job's next attempt. The one case where a
 * late-activated subscriber is never mailed is if their chunk was already sent and accepted in
 * an earlier attempt and the job has since reached a terminal state — by design, not a bug:
 * freezing trades "catch every last-second activation" for stable, safe-to-retry chunk
 * membership). */
async function countLateDeliveries(db: Db, jobId: string): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(jobRecipients)
    .innerJoin(subscribers, eq(subscribers.id, jobRecipients.subscriberId))
    .where(and(eq(jobRecipients.jobId, jobId), eq(subscribers.status, "active"), isNull(jobRecipients.chunkIndex)));
  return row?.count ?? 0;
}

/** `key` is the chunk's own idempotency suffix — normally just its `chunk_index` (as a
 * string), or `<chunk_index>.<part>` when {@link splitChunkByBytes} had to split it further.
 *
 * `substitutions` (Task 3's recipientSubstitutions, keyed by subscriberId) carries each
 * recipient's own `{{manageUrl}}`/`{{unsubscribeUrl}}` values; omitted (or a member missing
 * from the map) during the byte-size probe in {@link partitionChunkByBytes}, where no real
 * links have been built yet — every member gets `{}` there, same as every other member, so the
 * probe's *relative* sizing is unaffected. */
function buildMessageRequest(
  job: ClaimedJobRow,
  members: Member[],
  key: string,
  substitutions?: Map<string, { manageUrl: string; unsubscribeUrl: string }>,
): MessageRequest {
  return {
    priority: job.priority,
    idempotencyKey: `${job.id}:${key}`,
    subject: job.subject ?? "",
    html: job.html ?? "",
    text: job.text ?? undefined,
    headers: { "List-Unsubscribe": "<{{unsubscribeUrl}}>", "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" },
    recipients: members.map((m) => ({ email: m.email, substitutions: substitutions?.get(m.subscriberId) ?? {} })),
  };
}

function requestByteSize(req: MessageRequest): number {
  return Buffer.byteLength(JSON.stringify(req), "utf8");
}

/**
 * M3/R3: a chunk sized only by recipient count (MAX_RECIPIENTS_PER_CHUNK) can still produce a
 * request whose JSON payload is too big if recipients carry sizeable per-recipient
 * substitutions — so split it further whenever its request would exceed `maxBytes`. Members
 * are assumed roughly uniform in size (a manage link built the same way for everyone), so the
 * first candidate split's measured size is representative of the rest: `n` only grows until one
 * probe fits, rather than measuring every part. Each part keeps `chunkIndex`'s own identity in
 * its key (`<chunkIndex>` when not split at all, `<chunkIndex>.<part>` otherwise) so retries
 * address the same sub-parts (and the same Distribution idempotencyKey) every time.
 *
 * R3: sized and partitioned over `members` — this chunk's *entire frozen membership*,
 * active or not (see fetchAssignedMembers) — never over an active-only subset, so the
 * number of parts and who falls in which one can't shift as subscribers go active/inactive
 * between attempts. Returns the *membership* of each part, not yet filtered to active-only
 * or built into a request — that happens in sendAllChunks, per attempt.
 */
function partitionChunkByBytes(job: ClaimedJobRow, members: Member[], chunkIndex: number, maxBytes: number): { key: string; members: Member[] }[] {
  let n = 1;
  while (n < members.length) {
    const size = Math.ceil(members.length / n);
    const probe = buildMessageRequest(job, members.slice(0, size), String(chunkIndex));
    if (requestByteSize(probe) <= maxBytes) break;
    n++;
  }
  if (n === 1) return [{ key: String(chunkIndex), members }];

  const partSize = Math.ceil(members.length / n);
  const parts: { key: string; members: Member[] }[] = [];
  for (let i = 0, part = 0; i < members.length; i += partSize, part++) {
    parts.push({ key: `${chunkIndex}.${part}`, members: members.slice(i, i + partSize) });
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
 *
 * R3: a part's membership is frozen (partitionChunkByBytes, over the whole chunk regardless of
 * active status); only now, per attempt, is it filtered down to members currently active —
 * so a subscriber who goes inactive between attempts simply drops out of their part's recipient
 * list (the part keeps its key and its other members) rather than shifting anyone's part
 * assignment. A part with zero currently-active members is skipped entirely: no request sent,
 * no batchId recorded for it this attempt (any batchId it already earned on an earlier attempt
 * stays in the merged `batch_ids`, untouched — see sendDueJobs).
 *
 * Per-recipient links (Task 3): `recipientSubstitutions` is called for a part's active members
 * only right before that part is actually sent — never for a part skipped because nobody in it
 * is currently active, and never for the inactive members of a part that *is* sent (R3: those
 * stay in `partMembers` for frozen partitioning but never carry their own links). On success,
 * `deliveries.attempted_at` is stamped (database clock) for exactly this job's rows belonging
 * to the members just sent to — the "sent part" the global constraints call for.
 */
async function sendAllChunks(
  opts: { db: Db; distribution: DistributionClient; links: RecipientLinkOptions; now?: TestClock },
  job: ClaimedJobRow,
  chunks: Map<number, Member[]>,
  maxChunkBytes: number,
): Promise<{ batchIds: Record<string, string>; error?: DistributionError }> {
  const batchIds: Record<string, string> = {};
  for (const [chunkIndex, members] of chunks) {
    for (const { key, members: partMembers } of partitionChunkByBytes(job, members, chunkIndex, maxChunkBytes)) {
      const activeMembers = partMembers.filter((m) => m.active);
      if (activeMembers.length === 0) continue; // nothing currently active in this part — skip it this attempt
      try {
        const substitutions = await recipientSubstitutions(opts.db, activeMembers, opts.links);
        const { batchId } = await opts.distribution.send(buildMessageRequest(job, activeMembers, key, substitutions));
        batchIds[key] = batchId;
        await opts.db
          .update(deliveries)
          .set({ attemptedAt: sqlNow(opts.now) })
          .where(and(eq(deliveries.jobId, job.id), inArray(deliveries.subscriberId, activeMembers.map((m) => m.subscriberId))));
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

/**
 * Clock (P2-R22 D1): every comparison and stamp uses the database's clock — the claim's due
 * and lock predicates use `now()`, the lock is `now() + budget` (later extended relative to
 * itself) and its exact value is returned as the ownership token, retry backoff is computed
 * from `now()` at the terminal write, and a job's age is its age at claim time (computed in
 * SQL) plus the monotonic time elapsed since. `opts.now`, a test hook, replaces SQL `now()`
 * with its value in every statement this call makes.
 *
 * Pause (global constraints): checked once, before anything is claimed — while
 * `nod_settings.paused` is true, this call claims nothing at all (items/deliveries/jobs keep
 * being recorded elsewhere; only the sender stands down).
 *
 * Cancellation (review focus 2): a job claimed for an item that has since been withdrawn
 * (`items.withdrawn_at`) is marked `cancelled` and released, unsent — checked right after the
 * claim, before any chunk work, so a withdrawn release's job never reaches Distribution.
 */
export async function sendDueJobs(
  opts: SendJobsOptions,
): Promise<{ sent: number; retried: number; failed: number; cancelled: number; paused: boolean }> {
  const batchSize = opts.batchSize ?? DEFAULT_BATCH_SIZE;
  const maxAgeMs = opts.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
  const chunkSize = opts.chunkSize ?? MAX_RECIPIENTS_PER_CHUNK;
  const perChunkMs = opts.perChunkMs ?? DEFAULT_PER_CHUNK_MS;
  const maxChunkBytes = opts.maxChunkBytes ?? MAX_CHUNK_BYTES;

  const [settings] = await opts.db.select({ paused: nodSettings.paused }).from(nodSettings);
  if (settings?.paused) {
    return { sent: 0, retried: 0, failed: 0, cancelled: 0, paused: true };
  }

  const result = { sent: 0, retried: 0, failed: 0, cancelled: 0, paused: false };

  for (let i = 0; i < batchSize; i++) {
    const sinceClaim = stopwatch();
    // Sized just to outlive assigning chunks + the recipient/late-delivery lookups + the
    // lock-extend below — real sizing (based on this job's own chunk count) happens once
    // that's known, via extendLock.
    const job = await claimOneJob(opts.db, sqlNow(opts.now), perChunkMs + LOCK_MARGIN_MS);
    if (!job) break;

    if (job.item_key) {
      const [item] = await opts.db.select({ withdrawnAt: items.withdrawnAt }).from(items).where(eq(items.key, job.item_key));
      if (item?.withdrawnAt) {
        const res = await opts.db
          .update(sendJobs)
          .set({ status: "cancelled", lockedUntil: null })
          .where(and(eq(sendJobs.id, job.id), ownedPending(sendJobs, job.lock_token)));
        if (res.rowCount) result.cancelled++;
        continue;
      }
    }

    let chunks: Map<number, Member[]>;
    let lockToken: LockToken;
    try {
      if (!job.chunks_assigned) {
        await ensureChunksAssigned(opts.db, job.id, chunkSize);
      }
      const lateCount = await countLateDeliveries(opts.db, job.id);
      if (lateCount > 0) {
        console.log(`[nod] job ${job.id} item ${job.item_key}: ${lateCount} recipient(s) arrived after chunking was frozen and are not part of this attempt`);
      }

      chunks = await fetchAssignedMembers(opts.db, job.id);
      // Total budget, from the claim's own now(): chunks.size (every chunk this attempt will
      // actually send) * perChunkMs (worst case every one hits the request timeout) +
      // perChunkMs once more (getToken's own timeout — it can only block the whole attempt
      // once, since a successful fetch is cached) + the fixed margin. The claim already
      // reserved perChunkMs + margin, so the extension is the chunks' share.
      const reowned = await extendLock(opts.db, job.id, job.lock_token, chunks.size * perChunkMs);
      if (!reowned) continue; // lost ownership somehow; leave it for the next run
      lockToken = reowned;
    } catch (e) {
      await releaseLock(opts.db, job.id, job.lock_token);
      throw e;
    }

    const where = and(eq(sendJobs.id, job.id), ownedPending(sendJobs, lockToken));

    // No per-chunk ownership re-assert before each chunk send (unlike sender.ts's per-row
    // loop): chunk membership is frozen (ensureChunksAssigned) and every chunk's
    // idempotencyKey is stable across attempts, so even in the (already very unlikely) event
    // this call's lock were stolen mid-loop, a concurrent claimant would resend the exact same
    // chunks and Distribution would dedupe every one already accepted. The only write that
    // has to be ownership-checked is the terminal one below (`where`), which is.
    const { batchIds: newBatchIds, error } = await sendAllChunks(
      { db: opts.db, distribution: opts.distribution, links: opts.links, now: opts.now },
      job,
      chunks,
      maxChunkBytes,
    );
    // P2-R16: merge newly-accepted chunk ids into whatever this job already had recorded —
    // persisted below on every attempt, including one that ends in "failed" or "retried", so
    // a chunk accepted before a later chunk failed is never re-sent as if it were unknown.
    const batchIds = { ...job.batch_ids, ...newBatchIds };

    if (!error) {
      const res = await opts.db.update(sendJobs).set({ status: "sent", batchIds, lockedUntil: null, lastError: null }).where(where);
      if (res.rowCount) result.sent++;
      continue;
    }

    const attempts = job.attempts + 1;
    const age = Number(job.age_ms) + sinceClaim();
    if (!error.retryable || age >= maxAgeMs) {
      const res = await opts.db.update(sendJobs).set({ status: "failed", attempts, batchIds, lockedUntil: null, lastError: error.message }).where(where);
      // I5: a job going failed is otherwise silent — nothing else notices a release that
      // stopped mailing. Logged once, only when this call actually made the write (the
      // ownership-guarded `where` matched), not on every attempt that merely observes it.
      if (res.rowCount) {
        result.failed++;
        console.error(`[nod] job ${job.id} item ${job.item_key} failed: ${error.message}`);
      }
    } else {
      const res = await opts.db
        .update(sendJobs)
        .set({ attempts, batchIds, nextAttemptAt: sqlNowPlus(backoffMs(attempts), opts.now), lockedUntil: null, lastError: error.message })
        .where(where);
      if (res.rowCount) {
        result.retried++;
        console.warn(`[nod] job ${job.id} item ${job.item_key} retrying (attempt ${attempts}): ${error.message}`);
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

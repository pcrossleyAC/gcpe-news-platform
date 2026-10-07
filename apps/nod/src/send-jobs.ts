import { and, eq, inArray, isNotNull, isNull, sql, type SQL } from "drizzle-orm";
import { ageMsOf, lockTokenOf, ownedPending, sqlInterval, sqlNow, sqlNowPlus, stopwatch, type Db, type LockToken, type TestClock } from "@gcpe/db-kit";
import { backoffMs } from "@gcpe/events";
import { DistributionError, type DistributionClient, type MessageRequest } from "./distribution-client";
import { deliveries, jobRecipients, nodSettings, sendJobs, subscribers, type ItemKind } from "./db/schema";
import { renderDigestItems } from "./digest";
import { placeholderLinkLengths, recipientSubstitutions, type RecipientLinkOptions } from "./recipient-links";
import { replyToFor, type ReplyToOptions } from "./reply-to";
import type { RenderOptions } from "./render";
import { emailAddressSchema } from "./subscribe/info";
import { safeErrorLabel } from "./subscribe/journeys";

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
  /** Site URL and optional banner for every outbound email this sends -- only actually used to
   * re-render a digest job (see {@link sendDueJobs}'s doc comment) whose items have partly
   * withdrawn since it was built; an As-It-Happens/emergency job's content never changes here. */
  render: RenderOptions;
  /** Reply-To by type of news (reply-to.ts), chosen per job from its item. */
  replyTo?: ReplyToOptions;
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
  /** Test hook: called inside the withdrawn-check transaction, after the `FOR SHARE` read
   * confirms the item is withdrawn, before the cancel write — see {@link sendDueJobs}'s doc
   * comment. Production call sites never pass it. */
  onWithdrawnCheck?: () => void | Promise<void>;
}

type ClaimedJobRow = {
  id: string;
  item_key: string | null;
  item_kind: ItemKind | null;
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
        -- Immediate (As-It-Happens/emergency) jobs are claimed ahead of digest jobs due at the
        -- same time -- (priority = 'digest') is false (sorts first) for immediate/media/
        -- system priorities and true (sorts after) for digest, so a 17:00 digest batch never
        -- delays an emergency/As-It-Happens job created just after it. Ties within the same
        -- priority bucket still break on next_attempt_at, then id, as before.
        ORDER BY (priority = 'digest'), next_attempt_at, id
        LIMIT 1
        FOR UPDATE SKIP LOCKED
     )
    RETURNING id, item_key,
              (SELECT i.kind FROM items i WHERE i.key = send_jobs.item_key) AS item_kind,
              priority, kind, subject, html, text, attempts, ${ageMsOf(sql`created_at`, now)} AS age_ms, chunks_assigned, batch_ids,
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
  replyTo?: string,
): MessageRequest {
  return {
    priority: job.priority,
    idempotencyKey: `${job.id}:${key}`,
    subject: job.subject ?? "",
    html: job.html ?? "",
    text: job.text ?? undefined,
    headers: { "List-Unsubscribe": "<{{unsubscribeUrl}}>", "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" },
    recipients: members.map((m) => ({ email: m.email, substitutions: substitutions?.get(m.subscriberId) ?? {} })),
    ...(replyTo ? { replyTo } : {}),
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
 *
 * `linkPlaceholder` stands in for every member's real `{{manageUrl}}`/`{{unsubscribeUrl}}`
 * substitutions during this probe -- same-length strings (placeholderLinkLengths), not real
 * tokens, so the probe's measured size already includes what every actual send-time request
 * will add once `recipientSubstitutions` fills them in for real (see sendAllChunks). Probing
 * with no substitutions at all (every member getting `{}`) would under-measure a request whose
 * per-recipient links are a significant share of its size -- most visible for a media job,
 * whose full release text can otherwise make the link overhead look negligible by comparison
 * when it isn't, once thousands of recipients are added up.
 */
function partitionChunkByBytes(
  job: ClaimedJobRow,
  members: Member[],
  chunkIndex: number,
  maxBytes: number,
  linkPlaceholder: { manageUrl: string; unsubscribeUrl: string },
  replyTo: string | undefined,
): { key: string; members: Member[] }[] {
  let n = 1;
  while (n < members.length) {
    const size = Math.ceil(members.length / n);
    const slice = members.slice(0, size);
    const probeSubstitutions = new Map(slice.map((m) => [m.subscriberId, linkPlaceholder]));
    const probe = buildMessageRequest(job, slice, String(chunkIndex), probeSubstitutions, replyTo);
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
 * stay in `partMembers` for frozen partitioning but never carry their own links).
 *
 * Defence in depth: Media Hub's own contract doesn't require `.email()`
 * on `address` (media-hub/contract.ts), and although both the nightly sync and staff resolve now
 * validate at write time, a row written before that existed (or any other path into
 * `subscribers.email`) must never reach Distribution's own `z.string().email()` check — which
 * answers 400 for the *whole* request and isn't retryable, failing this part and every later
 * part of the job, on every attempt. So each part's active members are filtered against that
 * same schema immediately before the request is built; anyone failing it is dropped from this
 * part (logged by subscriber id only, never the address — global constraints "Logs"; counted,
 * not treated as an error) and left unattempted, so they're not stamped `attempted_at` and stay
 * eligible once their address is fixed. A part left with no valid recipients sends nothing and
 * is not an error. Counts are logged rather than threaded through this function's return value,
 * to avoid changing `sendDueJobs`'s result shape (and the many tests asserting it exactly).
 *
 * Controller ruling (overrides the brief's "after a successful send"): `deliveries.attempted_at`
 * is stamped *immediately before* `distribution.send` — handed off, not confirmed — because a
 * response that was actually accepted by Distribution but lost to us (a timeout, a dropped
 * connection after Distribution already committed) must still count as "attempted": otherwise a
 * withdraw racing the sender could see an unattempted delivery, delete it, and a later republish
 * would double-send. The `attempted_at IS NULL` guard means a
 * retry of a part already handed off (including one that's resent whole on a later attempt,
 * same as every other chunk) never re-stamps it — retries still work regardless, since
 * recipients are re-derived from `job_recipients`, never from `deliveries`.
 */
async function sendAllChunks(
  opts: { db: Db; distribution: DistributionClient; links: RecipientLinkOptions; now?: TestClock; replyTo?: ReplyToOptions },
  job: ClaimedJobRow,
  chunks: Map<number, Member[]>,
  maxChunkBytes: number,
): Promise<{ batchIds: Record<string, string>; error?: DistributionError }> {
  const batchIds: Record<string, string> = {};
  const replyTo = replyToFor(job.item_kind, opts.replyTo ?? {});
  const { manageUrlLen, unsubscribeUrlLen } = placeholderLinkLengths(opts.links);
  const linkPlaceholder = { manageUrl: "x".repeat(manageUrlLen), unsubscribeUrl: "x".repeat(unsubscribeUrlLen) };
  for (const [chunkIndex, members] of chunks) {
    for (const { key, members: partMembers } of partitionChunkByBytes(job, members, chunkIndex, maxChunkBytes, linkPlaceholder, replyTo)) {
      const activeMembers = partMembers.filter((m) => m.active);
      if (activeMembers.length === 0) continue; // nothing currently active in this part — skip it this attempt

      // Defence in depth — see the doc comment above.
      const validMembers = activeMembers.filter((m) => emailAddressSchema.safeParse(m.email).success);
      if (validMembers.length < activeMembers.length) {
        const invalidIds = activeMembers.filter((m) => !validMembers.includes(m)).map((m) => m.subscriberId);
        console.error(`[nod] job ${job.id} part ${key}: dropping ${invalidIds.length} recipient(s) with an invalid email address, subscriber ids: ${invalidIds.join(",")}`);
      }
      if (validMembers.length === 0) continue; // nothing left to send in this part — not an error

      try {
        const substitutions = await recipientSubstitutions(opts.db, validMembers, opts.links);
        // Stamped before the handoff, not after — see the doc comment above.
        await opts.db
          .update(deliveries)
          .set({ attemptedAt: sqlNow(opts.now) })
          .where(
            and(
              eq(deliveries.jobId, job.id),
              inArray(deliveries.subscriberId, validMembers.map((m) => m.subscriberId)),
              isNull(deliveries.attemptedAt),
            ),
          );
        const { batchId } = await opts.distribution.send(buildMessageRequest(job, validMembers, key, substitutions, replyTo));
        batchIds[key] = batchId;
        // What bounces.ts's own first match attempt looks for -- stamped only on the
        // deliveries actually handed off in *this* part, right after Distribution accepts it
        // (never on a part that throws below, which has no batchId to record).
        await opts.db
          .update(deliveries)
          .set({ distributionBatchId: batchId })
          .where(and(eq(deliveries.jobId, job.id), inArray(deliveries.subscriberId, validMembers.map((m) => m.subscriberId))));
      } catch (e) {
        // P2-R16: any error here is treated as retryable (bounded below by maxAgeMs) unless
        // distribution-client.ts itself deliberately classified it otherwise — an *unexpected*
        // error (anything not already a DistributionError) must never permanently fail a job.
        //
        // Logs constraint: `e.message` is only safe when `e` is already a
        // DistributionError (its message is Distribution's own HTTP status/body text, never a
        // bound SQL value). Any other error — notably a `recipientSubstitutions` DB failure,
        // whose drizzle `DrizzleQueryError` message is `Failed query: <sql>\nparams: <params>`
        // and binds each row's email/subscriberId — must never have its raw message stored in
        // `send_jobs.last_error` or logged; `safeErrorLabel` (a Postgres error code, or failing
        // that the error's name) is informative without carrying the bound value.
        const error = e instanceof DistributionError ? e : new DistributionError(`unexpected send error: ${safeErrorLabel(e)}`, true);
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
 *
 * A digest job (`kind: 'digest'`, `item_key` null) carries several items, so the single-item
 * check above can't see it; its own items are read back from its `deliveries` instead, their
 * `items.withdrawn_at` locked `FOR SHARE` the same way. If every one of them is withdrawn, the
 * job is cancelled exactly like a single-item job. If only some are, this call deletes that
 * job's not-yet-attempted `deliveries` for just the withdrawn items and re-renders the job's
 * subject/html/text (`renderDigestItems`, digest.ts) from the survivors, then sends that —
 * never the content built back when the digest was first assembled. If none are withdrawn, the
 * job is sent unchanged, same as always.
 *
 * The withdrawn check reads `items.withdrawn_at` with `FOR SHARE` — a row
 * lock, not a plain read. `withdrawItem` (items.ts) never locks the `items` row itself before
 * selecting the unclaimed jobs to delete; without a lock here, this read could land in the gap
 * between that `withdrawItem` transaction's `UPDATE items SET withdrawn_at = now()` and its
 * commit, see the old (uncommitted) NULL, and send — after which `withdrawItem` deletes the job
 * out from under a send already in flight. `FOR SHARE` makes this read block behind any
 * concurrent `UPDATE ... WHERE key = ...` on the same row (every UPDATE takes an implicit
 * row-level lock) until that transaction commits or rolls back, so it only ever sees the
 * committed value — items.ts itself is untouched.
 *
 * That `FOR SHARE` read and the cancel write it guards must happen in one
 * transaction (`opts.db.transaction`, not two separate `opts.db` statements) — otherwise the
 * read's own row lock is released the instant it finishes (a standalone statement is its own
 * implicit transaction), reopening a gap of exactly the kind the lock above closed: a republish
 * (`upsertReleaseItem` clearing `withdrawn_at`, then `createItemSend` in the same transaction,
 * as-it-happens.ts) can run and commit *between* this call's read and its cancel write. Seen
 * from the republish's side, the job still reads `pending` (this call hasn't cancelled it yet),
 * so its `ON CONFLICT (job_key) DO NOTHING` is a no-op — and then this call's cancel write lands
 * right after, cancelling the one job that would ever have been sent, while the item is now
 * live. Holding the `FOR SHARE` lock for the lifetime of one transaction that also does the
 * cancel write forces the republish's own `UPDATE items` to serialise with it: either the
 * republish's update blocks until this transaction commits (cancel already written) and its
 * `createItemSend` then finds the job `cancelled` — which the controller ruling (as-it-
 * happens.ts) replaces with a fresh pending job — or the republish commits first and this read
 * sees the committed, cleared `withdrawn_at`, so nothing is cancelled and the job sends
 * normally. Either way, never "live item, only a cancelled job, nothing fresh".
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
      // FOR SHARE and the cancel write happen in one transaction — see the doc comment above.
      const outcome = await opts.db.transaction(async (tx) => {
        const { rows: itemRows } = await tx.execute<{ withdrawn_at: Date | null }>(
          sql`SELECT withdrawn_at FROM items WHERE key = ${job.item_key} FOR SHARE`,
        );
        if (!itemRows[0]?.withdrawn_at) return { withdrawn: false, cancelled: false };
        // Test hook: fires while this transaction still holds the FOR SHARE lock, so a test
        // can start a concurrent republish and prove it blocks behind this transaction rather
        // than racing it. Production call sites never pass it.
        await opts.onWithdrawnCheck?.();
        const res = await tx
          .update(sendJobs)
          .set({ status: "cancelled", lockedUntil: null })
          .where(and(eq(sendJobs.id, job.id), ownedPending(sendJobs, job.lock_token)));
        return { withdrawn: true, cancelled: (res.rowCount ?? 0) > 0 };
      });
      if (outcome.withdrawn) {
        if (outcome.cancelled) result.cancelled++;
        continue;
      }
    } else if (job.kind === "digest") {
      // Same FOR SHARE + write-in-one-transaction pattern as the item-job check above, keyed
      // off every item this job's own deliveries carry (see the doc comment above).
      const outcome = await opts.db.transaction(async (tx) => {
        const deliveryRows = await tx.select({ itemKey: deliveries.itemKey }).from(deliveries).where(eq(deliveries.jobId, job.id));
        const itemKeys = [...new Set(deliveryRows.map((d) => d.itemKey))];
        if (itemKeys.length === 0) return { kind: "unchanged" as const };

        const { rows: itemRows } = await tx.execute<{ key: string; withdrawn_at: string | null }>(
          sql`SELECT key, withdrawn_at FROM items WHERE key = ANY(${sql.param(itemKeys)}::text[]) FOR SHARE`,
        );
        const withdrawnKeys = itemRows.filter((r) => r.withdrawn_at).map((r) => r.key);
        if (withdrawnKeys.length === 0) return { kind: "unchanged" as const };

        if (withdrawnKeys.length === itemKeys.length) {
          // Every one of this job's deliveries is for a now-withdrawn item, so (same as the
          // "some withdrawn" path below) its not-yet-attempted deliveries must be deleted here,
          // in the same transaction as the cancel write. Left behind, a `mode='digest'` row for
          // a since-republished item would permanently block that item's As-It-Happens send to a
          // both-timings subscriber (as-it-happens.ts's `NOT EXISTS ... mode='digest'` guard),
          // so a republish would reach them neither by digest (job cancelled) nor As-It-Happens.
          await tx.delete(deliveries).where(and(eq(deliveries.jobId, job.id), isNull(deliveries.attemptedAt)));
          const res = await tx
            .update(sendJobs)
            .set({ status: "cancelled", lockedUntil: null })
            .where(and(eq(sendJobs.id, job.id), ownedPending(sendJobs, job.lock_token)));
          return { kind: "cancelled" as const, wrote: (res.rowCount ?? 0) > 0 };
        }

        const remainingKeys = itemKeys.filter((k) => !withdrawnKeys.includes(k));
        await tx
          .delete(deliveries)
          .where(and(eq(deliveries.jobId, job.id), inArray(deliveries.itemKey, withdrawnKeys), isNull(deliveries.attemptedAt)));
        const rendered = await renderDigestItems(tx, remainingKeys, opts.render);
        await tx
          .update(sendJobs)
          .set({ subject: rendered.subject, html: rendered.html, text: rendered.text })
          .where(and(eq(sendJobs.id, job.id), ownedPending(sendJobs, job.lock_token)));
        return { kind: "shrunk" as const, rendered };
      });

      if (outcome.kind === "cancelled") {
        if (outcome.wrote) result.cancelled++;
        continue;
      }
      if (outcome.kind === "shrunk") {
        // This attempt's own in-memory copy of the claimed job must reflect the re-render too
        // -- sendAllChunks/buildMessageRequest below read job.subject/html/text directly, and
        // the write above only updated the row, not this object.
        job.subject = outcome.rendered.subject;
        job.html = outcome.rendered.html;
        job.text = outcome.rendered.text;
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
      { db: opts.db, distribution: opts.distribution, links: opts.links, now: opts.now, replyTo: opts.replyTo },
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
      // A job going failed is otherwise silent — nothing else notices a release that
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

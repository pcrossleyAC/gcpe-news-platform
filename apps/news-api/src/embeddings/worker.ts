import { eq, inArray, sql } from "drizzle-orm";
import { withAdvisoryLock, type Db } from "@gcpe/db-kit";
import { BreakerOpenError, type GuardedEmbedder } from "@gcpe/embeddings";
import { postEmbeddingFailures, postEmbeddings, posts } from "../db/schema";
import { VECTOR_DIMENSIONS } from "./pgvector";
import { embeddingSourceText, embeddingTextHash } from "./source-text";

export const EMBEDDING_BATCH_SIZE = 50;
export const RELATED_LIMIT = 5;
/** The worker's own provider timeout: spec §4's ceiling, since a batch is up to 50 long texts. */
export const WORKER_EMBED_TIMEOUT_MS = 5000;
/**
 * The cap on provider calls per tick, as a multiple of the batch size: isolating a single
 * poison post out of a full batch by halving costs about 2*log2(batchSize) calls, so this
 * leaves comfortable headroom while still bounding the pathological case (most of the batch
 * poisoned) to a bounded number of calls instead of unbounded recursion.
 */
export const EMBEDDING_MAX_CALLS_FACTOR = 2;

/**
 * Two-int advisory key (the "gcpe" space db-kit's migration lock uses; see changes.ts's
 * CHANGES_LOCK, slot 4, in this same database). Slot 5 is this worker's own, so it can't
 * collide with the change feed's lock, with lockIdentity's (projections.ts) single-bigint
 * `hashtext(...)` keyspace (a completely separate Postgres lock space from the two-int form),
 * or with db-kit's migration lock (slot 1).
 *
 * Why this can never deadlock against the change-feed or projection locks: `withAdvisoryLock`
 * takes it with `pg_try_advisory_lock` (never blocking) on its own dedicated connection, not the
 * one the tick's own transaction runs on, and releases it with `pg_advisory_unlock` in a
 * `finally`. A lock acquired by a non-blocking try can never be a link in a wait-for cycle: this
 * session either has it already or gives up immediately, so it never sits blocked holding one
 * resource while waiting on another. Nothing else in the codebase ever requests this exact key,
 * so it is also never contended from the other side. The tick's own transaction still takes
 * ordinary row locks on `posts`/`post_embeddings` (FOR UPDATE/FOR SHARE) exactly as before; that
 * is unaffected by this guard, which runs on a separate connection throughout.
 */
export const EMBED_TICK_LOCK = [0x67637065, 5] as const;

class EmbeddingTickBusyError extends Error {}

export interface EmbeddingTickResult {
  embedded: number;
  rehashed: number;
  related: number;
  skipped: "breaker-open" | "provider-failed" | "locked" | null;
}

type Candidate = {
  key: string;
  searchText: string;
  postHash: string | null;
  embeddedHash: string | null;
  provider: string | null;
  model: string | null;
  dimensions: number | null;
};

/**
 * One tick of spec §5.2's worker: up to `batchSize` published posts with no embedding, or whose
 * text hash, provider, model or dimensions differ, newest first; one provider call; then each
 * post's related list. Only for semantic mode (the caller decides). Drafts never reach the News
 * API, and unpublished posts are never selected, so post_embeddings holds published posts only.
 *
 * Guarded by EMBED_TICK_LOCK (`pg_try_advisory_lock`, never blocking): the News API's own
 * internal 60 s loop and /stack/tick's `news-api.embed` step both call this, in the same
 * process, with no other coordination between them, and either could overlap a replica's own
 * tick too. Without the guard, an overlap sends the same batch to the provider twice (double
 * cost, no correctness bug — the write transaction's row lock still serialises the writes). An
 * overlapping call finds the lock held and returns `skipped: "locked"` immediately, before
 * touching the database for candidates or calling the provider at all; it is not an error and
 * never logs a line.
 */
export async function runEmbeddingTick(o: { db: Db; embedder: GuardedEmbedder; batchSize?: number; log?: (line: string) => void }): Promise<EmbeddingTickResult> {
  const { provider, breaker } = o.embedder;
  const log = o.log ?? ((line: string) => console.error(line));
  const none = { embedded: 0, rehashed: 0, related: 0 };
  if (breaker.state === "open") return { ...none, skipped: "breaker-open" };

  try {
    return await withAdvisoryLock(o.db, EMBED_TICK_LOCK, () => new EmbeddingTickBusyError(), () => tick(o, provider, log, none));
  } catch (e) {
    if (e instanceof EmbeddingTickBusyError) return { ...none, skipped: "locked" };
    throw e;
  }
}

type Work = Candidate & { source: string; hash: string };

/**
 * Embeds `items` (sources already extracted), isolating a poison post instead of letting it
 * stall every healthy post behind it. Starts with one call over the whole set; a failing
 * call (anything but an open breaker) is split in half and each half retried, recursing down to
 * single posts, so only the posts that share a batch with the bad one ever get re-tried more
 * than once. A post still failing alone is recorded in `failed`, not thrown.
 *
 * Processed breadth-first (a FIFO queue, not depth-first recursion): every failing batch's two
 * halves go to the *back* of the queue, so the next call made is always the oldest still-pending
 * one, never an immediate re-split of the batch that just failed. That bounds the run of
 * *consecutive* failures the breaker can see to at most two: the first is the full (or partial)
 * batch containing the poison post, the second is that batch's first half-after-split — and the
 * call right behind it in the queue is always a sibling batch that does *not* contain the poison
 * post, which succeeds and resets the breaker's failure count before a third consecutive failure
 * can ever happen. (`CircuitBreaker.run` only counts *consecutive* failures — any success resets
 * it to zero — so one poison post among healthy ones can never reach the threshold of 3, no
 * matter how large the original batch is.) Depth-first recursion doesn't have this property: it
 * would keep splitting and retrying the poison half before ever trying an unrelated sibling,
 * so the failure count climbs with the tree's depth and can open the breaker on a big batch.
 *
 * `maxCalls` bounds the provider calls this makes, win or lose, so a batch that's mostly poison
 * can't run up dozens of calls in one tick; whatever doesn't get attempted is left for the next
 * tick, exactly like a post this function never saw.
 */
async function embedIsolating(
  embedder: GuardedEmbedder,
  items: Work[],
  maxCalls: number,
): Promise<{ vectors: Map<string, number[]>; failed: Set<string>; breakerOpen: boolean }> {
  const vectors = new Map<string, number[]>();
  const failed = new Set<string>();
  let breakerOpen = false;
  let calls = 0;
  const queue: Work[][] = [items];
  while (queue.length > 0 && calls < maxCalls) {
    const batch = queue.shift()!;
    calls++;
    let result: number[][] | null;
    try {
      result = await embedder.embed(batch.map((w) => w.source));
    } catch (e) {
      if (e instanceof BreakerOpenError) {
        breakerOpen = true;
        break;
      }
      result = null;
    }
    if (result && result.length === batch.length && result.every((v) => v.length === VECTOR_DIMENSIONS)) {
      batch.forEach((w, i) => vectors.set(w.key, result![i]!));
      continue;
    }
    if (batch.length === 1) failed.add(batch[0]!.key);
    else {
      const mid = Math.ceil(batch.length / 2);
      queue.push(batch.slice(0, mid), batch.slice(mid));
    }
  }
  return { vectors, failed, breakerOpen };
}

async function tick(
  o: { db: Db; embedder: GuardedEmbedder; batchSize?: number },
  provider: GuardedEmbedder["provider"],
  log: (line: string) => void,
  none: { embedded: number; rehashed: number; related: number },
): Promise<EmbeddingTickResult> {
  const batchSize = o.batchSize ?? EMBEDDING_BATCH_SIZE;
  const { rows } = await o.db.execute<Candidate>(sql`
    SELECT p.key, p.search_text AS "searchText", p.embedding_text_hash AS "postHash",
           e.text_hash AS "embeddedHash", e.provider, e.model, e.dimensions
    FROM posts p
      LEFT JOIN post_embeddings e ON e.post_key = p.key
      LEFT JOIN post_embedding_failures f ON f.post_key = p.key AND f.text_hash = p.embedding_text_hash
    WHERE p.is_published AND p.search_text IS NOT NULL AND p.search_text <> '' AND f.post_key IS NULL
      AND (e.post_key IS NULL OR p.embedding_text_hash IS NULL OR e.text_hash <> p.embedding_text_hash
           OR e.provider <> ${provider.id} OR e.model <> ${provider.model} OR e.dimensions <> ${provider.dimensions})
    ORDER BY p.publish_date DESC, p.key COLLATE "C" DESC
    LIMIT ${batchSize}`);

  const work: Work[] = rows.map((r) => ({ ...r, source: embeddingSourceText(r.searchText), hash: embeddingTextHash(r.searchText) }));
  const current = (w: Work) => w.embeddedHash === w.hash && w.provider === provider.id && w.model === provider.model && w.dimensions === provider.dimensions;
  const toEmbed = work.filter((w) => !current(w));

  let vectors = new Map<string, number[]>();
  let failedKeys = new Set<string>();
  if (toEmbed.length === 1) {
    // Nothing to isolate a single candidate from: a lone post that fails is indistinguishable
    // from a plain provider outage, so this is left exactly as before — no per-post failure is
    // recorded, and the breaker's own consecutive-failure count is what opens it across ticks.
    try {
      const vs = await o.embedder.embed(toEmbed.map((w) => w.source));
      if (vs.length !== 1 || vs[0]!.length !== VECTOR_DIMENSIONS) {
        log(`[news-api] embedding batch from ${provider.id} had the wrong shape; skipped`);
        return { ...none, skipped: "provider-failed" };
      }
      vectors.set(toEmbed[0]!.key, vs[0]!);
    } catch (e) {
      // The guarded embedder logged a real provider failure, once, without the texts.
      return { ...none, skipped: e instanceof BreakerOpenError ? "breaker-open" : "provider-failed" };
    }
  } else if (toEmbed.length > 1) {
    const isolated = await embedIsolating(o.embedder, toEmbed, batchSize * EMBEDDING_MAX_CALLS_FACTOR);
    vectors = isolated.vectors;
    failedKeys = isolated.failed;
    // Nothing at all was decided this tick (every call either hit the open breaker or the
    // budget ran out before even one post was confirmed embedded or failed): report it exactly
    // as a whole-batch failure would be, so the caller's retry/backoff behaviour is unchanged.
    if (vectors.size === 0 && failedKeys.size === 0) return { ...none, skipped: isolated.breakerOpen ? "breaker-open" : "provider-failed" };
  }

  if (rows.length === 0) return { ...none, related: await relatedForOrphans(o.db, batchSize), skipped: null };

  const written = await o.db.transaction(async (tx) => {
    // Lock the posts first, as an unpublish does, then re-check: a post unpublished or rewritten
    // while the provider was working is left for the next tick, never given a stale vector.
    // SKIP LOCKED: a post the importer's bulk unpublish or search-backfill --all is
    // concurrently locking just isn't in `locked`, so `fresh()` is already false for it below
    // and it's left for the next tick — the worker never blocks on a posts row, so it can never
    // be one side of a deadlock with those other lockers.
    const locked = await tx
      .select({ key: posts.key, isPublished: posts.isPublished, searchText: posts.searchText })
      .from(posts)
      .where(inArray(posts.key, work.map((w) => w.key)))
      .for("update", { skipLocked: true });
    const byKey = new Map(locked.map((r) => [r.key, r]));
    const fresh = (w: Work) => {
      const r = byKey.get(w.key);
      return !!r && r.isPublished && r.searchText !== null && embeddingTextHash(r.searchText) === w.hash;
    };
    const keys: string[] = [];
    for (const w of toEmbed) {
      const v = vectors.get(w.key);
      if (!v || !fresh(w)) continue;
      const values = { postKey: w.key, provider: provider.id, model: provider.model, dimensions: provider.dimensions, textHash: w.hash, embedding: v };
      await tx.insert(postEmbeddings).values(values).onConflictDoUpdate({ target: postEmbeddings.postKey, set: { ...values, embeddedAt: sql`now()` } });
      await tx.delete(postEmbeddingFailures).where(eq(postEmbeddingFailures.postKey, w.key));
      keys.push(w.key);
    }
    for (const w of toEmbed) {
      if (!failedKeys.has(w.key) || !byKey.has(w.key)) continue;
      const values = { postKey: w.key, textHash: w.hash };
      await tx.insert(postEmbeddingFailures).values(values).onConflictDoUpdate({ target: postEmbeddingFailures.postKey, set: { ...values, failedAt: sql`now()` } });
    }
    let rehashed = 0;
    for (const w of work) {
      if (!fresh(w) || w.postHash === w.hash) continue;
      await tx.update(posts).set({ embeddingTextHash: w.hash }).where(eq(posts.key, w.key));
      if (current(w)) rehashed++;
    }
    return { keys, rehashed };
  });

  let related = 0;
  for (const key of written.keys) if (await computeRelated(o.db, key)) related++;
  related += await relatedForOrphans(o.db, batchSize);
  return { embedded: written.keys.length, rehashed: written.rehashed, related, skipped: null };
}

/**
 * A process that dies (or a transient database error) between `post_embeddings` committing
 * and `computeRelated` running for that key leaves a post with a current embedding and no
 * `post_related` row — forever, because the main candidate query above only looks at
 * `post_embeddings` vs. `posts`, never at `post_related`. This finds those posts directly and
 * recomputes their related list with no provider call at all: `computeRelated` is pure SQL.
 */
async function orphanedRelatedKeys(db: Db, limit: number): Promise<string[]> {
  const { rows } = await db.execute<{ key: string }>(sql`
    SELECT e.post_key AS key
    FROM post_embeddings e
      JOIN posts p ON p.key = e.post_key
      LEFT JOIN post_related r ON r.post_key = e.post_key
    WHERE p.is_published AND r.post_key IS NULL
    ORDER BY p.publish_date DESC, p.key COLLATE "C" DESC
    LIMIT ${limit}`);
  return rows.map((r) => r.key);
}

/**
 * Run after `written.keys` already has its related list (so this only ever sees genuinely
 * orphaned posts — the just-written ones already satisfy the query above's `r.post_key IS
 * NULL` by the time this runs) and also when the embedding candidate query found nothing at
 * all, so a tick with no embedding work to do still clears any backlog of orphans.
 */
async function relatedForOrphans(db: Db, batchSize: number): Promise<number> {
  let related = 0;
  for (const key of await orphanedRelatedKeys(db, batchSize)) if (await computeRelated(db, key)) related++;
  return related;
}

/**
 * post_related for `key`: the RELATED_LIMIT nearest other embeddings (all published, see above),
 * served by the HNSW index where it exists. The post row is share-locked and re-checked, so an
 * unpublish can't slip between the check and the write.
 */
async function computeRelated(db: Db, key: string): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [post] = await tx.select({ isPublished: posts.isPublished }).from(posts).where(eq(posts.key, key)).for("share");
    if (!post?.isPublished) return false;
    const target = sql`(SELECT embedding::vector(1536) FROM post_embeddings WHERE post_key = ${key}::text)`;
    const { rowCount } = await tx.execute(sql`
      INSERT INTO post_related (post_key, related_keys, computed_at)
      SELECT ${key}::text, coalesce(array_agg(n.post_key ORDER BY n.distance, n.post_key), '{}'), now()
      FROM (
        SELECT post_key, (embedding::vector(1536)) <=> ${target} AS distance
        FROM post_embeddings
        WHERE post_key <> ${key}::text
        ORDER BY (embedding::vector(1536)) <=> ${target}
        LIMIT ${RELATED_LIMIT}
      ) n
      WHERE EXISTS (SELECT 1 FROM post_embeddings WHERE post_key = ${key}::text)
      ON CONFLICT (post_key) DO UPDATE SET related_keys = excluded.related_keys, computed_at = excluded.computed_at`);
    return (rowCount ?? 0) > 0;
  });
}

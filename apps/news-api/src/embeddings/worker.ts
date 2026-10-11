import { eq, inArray, sql } from "drizzle-orm";
import { withAdvisoryLock, type Db } from "@gcpe/db-kit";
import { BreakerOpenError, type GuardedEmbedder } from "@gcpe/embeddings";
import { postEmbeddings, posts } from "../db/schema";
import { VECTOR_DIMENSIONS } from "./pgvector";
import { embeddingSourceText, embeddingTextHash } from "./source-text";

export const EMBEDDING_BATCH_SIZE = 50;
export const RELATED_LIMIT = 5;
/** The worker's own provider timeout: spec §4's ceiling, since a batch is up to 50 long texts. */
export const WORKER_EMBED_TIMEOUT_MS = 5000;

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

async function tick(
  o: { db: Db; embedder: GuardedEmbedder; batchSize?: number },
  provider: GuardedEmbedder["provider"],
  log: (line: string) => void,
  none: { embedded: number; rehashed: number; related: number },
): Promise<EmbeddingTickResult> {
  const { rows } = await o.db.execute<Candidate>(sql`
    SELECT p.key, p.search_text AS "searchText", p.embedding_text_hash AS "postHash",
           e.text_hash AS "embeddedHash", e.provider, e.model, e.dimensions
    FROM posts p LEFT JOIN post_embeddings e ON e.post_key = p.key
    WHERE p.is_published AND p.search_text IS NOT NULL AND p.search_text <> ''
      AND (e.post_key IS NULL OR p.embedding_text_hash IS NULL OR e.text_hash <> p.embedding_text_hash
           OR e.provider <> ${provider.id} OR e.model <> ${provider.model} OR e.dimensions <> ${provider.dimensions})
    ORDER BY p.publish_date DESC, p.key COLLATE "C" DESC
    LIMIT ${o.batchSize ?? EMBEDDING_BATCH_SIZE}`);
  if (rows.length === 0) return { ...none, skipped: null };

  const work = rows.map((r) => ({ ...r, source: embeddingSourceText(r.searchText), hash: embeddingTextHash(r.searchText) }));
  const current = (w: (typeof work)[number]) =>
    w.embeddedHash === w.hash && w.provider === provider.id && w.model === provider.model && w.dimensions === provider.dimensions;
  const toEmbed = work.filter((w) => !current(w));

  let vectors: number[][] = [];
  if (toEmbed.length > 0) {
    try {
      vectors = await o.embedder.embed(toEmbed.map((w) => w.source));
    } catch (e) {
      // The guarded embedder logged a real provider failure, once, without the texts.
      return { ...none, skipped: e instanceof BreakerOpenError ? "breaker-open" : "provider-failed" };
    }
    if (vectors.length !== toEmbed.length || vectors.some((v) => v.length !== VECTOR_DIMENSIONS)) {
      log(`[news-api] embedding batch from ${provider.id} had the wrong shape; skipped`);
      return { ...none, skipped: "provider-failed" };
    }
  }

  const written = await o.db.transaction(async (tx) => {
    // Lock the posts first, as an unpublish does, then re-check: a post unpublished or rewritten
    // while the provider was working is left for the next tick, never given a stale vector.
    const locked = await tx
      .select({ key: posts.key, isPublished: posts.isPublished, searchText: posts.searchText })
      .from(posts)
      .where(inArray(posts.key, work.map((w) => w.key)))
      .for("update");
    const byKey = new Map(locked.map((r) => [r.key, r]));
    const fresh = (w: (typeof work)[number]) => {
      const r = byKey.get(w.key);
      return !!r && r.isPublished && r.searchText !== null && embeddingTextHash(r.searchText) === w.hash;
    };
    const keys: string[] = [];
    for (const [i, w] of toEmbed.entries()) {
      if (!fresh(w)) continue;
      const values = { postKey: w.key, provider: provider.id, model: provider.model, dimensions: provider.dimensions, textHash: w.hash, embedding: vectors[i]! };
      await tx.insert(postEmbeddings).values(values).onConflictDoUpdate({ target: postEmbeddings.postKey, set: { ...values, embeddedAt: sql`now()` } });
      keys.push(w.key);
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
  return { embedded: written.keys.length, rehashed: written.rehashed, related, skipped: null };
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

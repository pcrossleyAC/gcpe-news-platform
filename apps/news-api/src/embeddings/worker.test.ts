import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import type { TestDatabase } from "@gcpe/db-kit";
import { createGuardedEmbedder, EmbeddingError, standInProvider, STAND_IN_MODEL, type EmbeddingProvider } from "@gcpe/embeddings";
import type { ReleaseRecord } from "@gcpe/events";
import { sampleRelease } from "@gcpe/events/testing";
import { closeHandle, createNewsTestDb, EVENT_SECRETS, writeTenantConfig } from "../../test/helpers";
import { applyRelease, unpublishRelease } from "../projections";
import { searchTextFor } from "../search/search-text";
import { startNewsApi } from "../start";
import { deleteSemanticRows } from "./rows";
import { embeddingTextHash } from "./source-text";
import { runEmbeddingTick } from "./worker";

function release(key: string, headline: string, publishDate = "2026-10-01T10:00:00-07:00", body = ""): ReleaseRecord {
  return {
    ...sampleRelease,
    key,
    reference: null,
    summary: null,
    keywords: null,
    location: null,
    publishDate,
    documents: [{ ...sampleRelease.documents[0]!, headline, subheadline: "", detailsHtml: body ? `<p>${body}</p>` : "" }],
  };
}

function spy(base: EmbeddingProvider = standInProvider()) {
  const calls: string[][] = [];
  const provider: EmbeddingProvider = {
    id: base.id,
    model: base.model,
    dimensions: base.dimensions,
    async embed(texts, signal) {
      calls.push(texts);
      return base.embed(texts, signal);
    },
  };
  return { provider, calls, embedder: createGuardedEmbedder({ provider, log: () => {} }) };
}

describe("runEmbeddingTick (spec §5.2)", () => {
  let tdb: TestDatabase;
  beforeAll(async () => {
    tdb = await createNewsTestDb();
  });
  afterAll(async () => {
    await tdb.drop();
  });
  beforeEach(async () => {
    await tdb.pool.query("TRUNCATE posts CASCADE");
  });
  const seed = async (...rs: ReleaseRecord[]) => {
    for (const r of rs) await tdb.db.transaction((tx) => applyRelease(tx, r, { notify: false }));
  };
  const embedded = async () => (await tdb.pool.query<{ post_key: string }>("SELECT post_key FROM post_embeddings ORDER BY post_key")).rows.map((r) => r.post_key);
  const relatedOf = async (key: string) =>
    (await tdb.pool.query<{ related_keys: string[] }>("SELECT related_keys FROM post_related WHERE post_key = $1", [key])).rows[0]?.related_keys;

  it("embeds published posts newest first, in batches, and never an unpublished one", async () => {
    await seed(release("A", "alpha", "2026-10-01T10:00:00-07:00"), release("B", "beta", "2026-10-02T10:00:00-07:00"), release("C", "gamma", "2026-10-03T10:00:00-07:00"), release("D", "delta", "2026-10-04T10:00:00-07:00"));
    await tdb.db.transaction((tx) => unpublishRelease(tx, "D"));
    const s = spy();
    expect(await runEmbeddingTick({ db: tdb.db, embedder: s.embedder, batchSize: 2 })).toMatchObject({ embedded: 2, skipped: null });
    expect(await embedded()).toEqual(["B", "C"]);
    expect(await runEmbeddingTick({ db: tdb.db, embedder: s.embedder, batchSize: 2 })).toMatchObject({ embedded: 1 });
    expect(await embedded()).toEqual(["A", "B", "C"]);
    expect(await runEmbeddingTick({ db: tdb.db, embedder: s.embedder, batchSize: 2 })).toEqual({ embedded: 0, rehashed: 0, related: 0, skipped: null });
    expect(s.calls.map((c) => c.length)).toEqual([2, 1]);
  });

  it("stores the provider, model, dimensions and text hash, and the post's own hash", async () => {
    const r = release("A", "salmon habitat");
    await seed(r);
    await runEmbeddingTick({ db: tdb.db, embedder: spy().embedder });
    const { rows } = await tdb.pool.query("SELECT provider, model, dimensions, text_hash, array_length(embedding, 1) AS n FROM post_embeddings");
    const hash = embeddingTextHash(searchTextFor(r));
    expect(rows).toEqual([{ provider: "stand-in", model: STAND_IN_MODEL, dimensions: 1536, text_hash: hash, n: 1536 }]);
    expect((await tdb.pool.query("SELECT embedding_text_hash FROM posts")).rows).toEqual([{ embedding_text_hash: hash }]);
  });

  it("re-embeds a post whose text changed, and leaves the others alone", async () => {
    await seed(release("A", "alpha"), release("B", "beta"));
    const s = spy();
    await runEmbeddingTick({ db: tdb.db, embedder: s.embedder });
    await seed(release("A", "alpha", undefined, "now with a body"));
    expect(await runEmbeddingTick({ db: tdb.db, embedder: s.embedder })).toMatchObject({ embedded: 1 });
    expect(s.calls[1]).toEqual(["alpha now with a body"]);
  });

  it("re-embeds every post when the provider's model changes", async () => {
    await seed(release("A", "alpha"), release("B", "beta"));
    await runEmbeddingTick({ db: tdb.db, embedder: spy().embedder });
    const next = spy({ ...standInProvider(), model: "stand-in-sha256-v2", embed: standInProvider().embed });
    expect(await runEmbeddingTick({ db: tdb.db, embedder: next.embedder })).toMatchObject({ embedded: 2 });
  });

  it("only rehashes a post written before 6b whose embedding is current, without calling the provider", async () => {
    await seed(release("A", "alpha"));
    const s = spy();
    await runEmbeddingTick({ db: tdb.db, embedder: s.embedder });
    await tdb.pool.query("UPDATE posts SET embedding_text_hash = NULL");
    expect(await runEmbeddingTick({ db: tdb.db, embedder: s.embedder })).toEqual({ embedded: 0, rehashed: 1, related: 0, skipped: null });
    expect(s.calls).toHaveLength(1);
    expect((await tdb.pool.query("SELECT embedding_text_hash IS NOT NULL AS ok FROM posts")).rows).toEqual([{ ok: true }]);
  });

  it("stops for the tick, without calling the provider, while the breaker is open", async () => {
    await seed(release("A", "alpha"));
    let calls = 0;
    const failing: EmbeddingProvider = { id: "failing", model: "m", dimensions: 1536, async embed() { calls++; throw new EmbeddingError("embedding_http_503"); } };
    const embedder = createGuardedEmbedder({ provider: failing, log: () => {} });
    for (let i = 0; i < 3; i++) expect(await runEmbeddingTick({ db: tdb.db, embedder })).toMatchObject({ skipped: "provider-failed" });
    expect(await runEmbeddingTick({ db: tdb.db, embedder })).toMatchObject({ skipped: "breaker-open" });
    expect(calls).toBe(3);
    expect(await embedded()).toEqual([]);
  });

  it("computes the 5 nearest published neighbours, nearest first, excluding the post itself", async () => {
    await seed(
      release("P0", "salmon river habitat"),
      release("P1", "salmon river habitat work"),
      release("P2", "salmon river"),
      release("P3", "salmon"),
      release("P4", "budget forecast"),
      release("P5", "school bus routes"),
      release("P6", "hospital beds"),
    );
    expect(await runEmbeddingTick({ db: tdb.db, embedder: spy().embedder })).toMatchObject({ embedded: 7, related: 7 });
    const related = await relatedOf("P0");
    expect(related).toHaveLength(5);
    expect(related!.slice(0, 3)).toEqual(["P1", "P2", "P3"]);
    expect(related).not.toContain("P0");
  });

  it("a post unpublished during the provider call gets no embedding or related row", async () => {
    await seed(release("RACE", "alpha"), release("KEEP", "beta"));
    const base = standInProvider();
    const racing: EmbeddingProvider = {
      ...base,
      async embed(texts, signal) {
        await tdb.db.transaction((tx) => unpublishRelease(tx, "RACE"));
        return base.embed(texts, signal);
      },
    };
    await runEmbeddingTick({ db: tdb.db, embedder: createGuardedEmbedder({ provider: racing, log: () => {} }) });
    expect(await embedded()).toEqual(["KEEP"]);
    expect(await relatedOf("RACE")).toBeUndefined();
  });

  it("a post rewritten during the provider call is left for the next tick, which embeds the new text", async () => {
    await seed(release("A", "alpha"));
    const base = standInProvider();
    let rewrite = true;
    const rewriting: EmbeddingProvider = {
      ...base,
      async embed(texts, signal) {
        if (rewrite) {
          rewrite = false;
          await tdb.db.transaction((tx) => applyRelease(tx, release("A", "alpha rewritten"), { notify: false }));
        }
        return base.embed(texts, signal);
      },
    };
    const embedder = createGuardedEmbedder({ provider: rewriting, log: () => {} });
    expect(await runEmbeddingTick({ db: tdb.db, embedder })).toMatchObject({ embedded: 0 });
    expect(await runEmbeddingTick({ db: tdb.db, embedder })).toMatchObject({ embedded: 1 });
    const { rows } = await tdb.pool.query("SELECT text_hash FROM post_embeddings");
    expect(rows).toEqual([{ text_hash: embeddingTextHash("alpha rewritten") }]);
  });

  it("unpublishing deletes the post's embedding and related row in the same transaction", async () => {
    await seed(release("A", "alpha"), release("B", "beta"));
    await runEmbeddingTick({ db: tdb.db, embedder: spy().embedder });
    await expect(
      tdb.db.transaction(async (tx) => {
        await unpublishRelease(tx, "a");
        throw new Error("rollback");
      }),
    ).rejects.toThrow("rollback");
    expect(await embedded()).toEqual(["A", "B"]);
    expect(await relatedOf("A")).toEqual(["B"]);
    await tdb.db.transaction((tx) => unpublishRelease(tx, "a"));
    expect(await embedded()).toEqual(["B"]);
    expect(await relatedOf("A")).toBeUndefined();
    expect(await relatedOf("B")).toEqual(["A"]);
  });

  it("two concurrent ticks over the same batch make exactly one provider call (EMBED_TICK_LOCK)", async () => {
    await seed(release("A", "alpha"), release("B", "beta"));
    const calls: string[][] = [];
    const base = standInProvider();
    const slow: EmbeddingProvider = {
      ...base,
      async embed(texts, signal) {
        calls.push(texts);
        // Wide enough that the second call's non-blocking lock attempt is guaranteed to land
        // while the first still holds it — this is what the test is exercising, not a race.
        await new Promise((r) => setTimeout(r, 100));
        return base.embed(texts, signal);
      },
    };
    const embedder = createGuardedEmbedder({ provider: slow, log: () => {} });
    const [r1, r2] = await Promise.all([runEmbeddingTick({ db: tdb.db, embedder }), runEmbeddingTick({ db: tdb.db, embedder })]);
    expect(calls).toHaveLength(1);
    expect([r1.skipped, r2.skipped].map((s) => s ?? "ran").sort()).toEqual(["locked", "ran"]);
    expect(await embedded()).toEqual(["A", "B"]);
  });

  it("isolates one poison post so the rest of the batch still embeds in the same tick", async () => {
    await seed(release("A", "alpha"), release("B", "beta"), release("C", "gamma"), release("D", "delta"));
    const base = standInProvider();
    const refusesGamma: EmbeddingProvider = {
      ...base,
      async embed(texts, signal) {
        if (texts.some((t) => t.includes("gamma"))) throw new EmbeddingError("embedding_http_400");
        return base.embed(texts, signal);
      },
    };
    const s = spy(refusesGamma);
    const r1 = await runEmbeddingTick({ db: tdb.db, embedder: s.embedder });
    expect(r1.embedded).toBe(3);
    expect(await embedded()).toEqual(["A", "B", "D"]);
    // The breaker never sees 3 consecutive failures from one poison post among healthy ones:
    // a sibling batch without "gamma" always succeeds soon after one that has it, resetting the
    // breaker's count, however many times the poison post's own batch gets halved.
    expect(s.embedder.breaker.state).toBe("closed");

    // Skipped on later ticks: no further provider call is made for the poison post.
    const callsBeforeNextTick = s.calls.length;
    const r2 = await runEmbeddingTick({ db: tdb.db, embedder: s.embedder });
    expect(r2).toMatchObject({ embedded: 0, skipped: null });
    expect(s.calls).toHaveLength(callsBeforeNextTick);
    expect(await embedded()).toEqual(["A", "B", "D"]);

    // Retried once its text changes, and now succeeds (the new text has no "gamma" in it).
    await seed(release("C", "zeta"));
    const r3 = await runEmbeddingTick({ db: tdb.db, embedder: s.embedder });
    expect(r3.embedded).toBe(1);
    expect(await embedded()).toEqual(["A", "B", "C", "D"]);
  });

  it("recomputes a related list left missing by a process restart, without calling the provider", async () => {
    await seed(release("A", "alpha"), release("B", "beta"), release("C", "gamma"), release("D", "delta"));
    const s = spy();
    await runEmbeddingTick({ db: tdb.db, embedder: s.embedder });
    expect(await relatedOf("D")).toBeDefined();
    // Simulate the process dying between the embedding commit and this post's own computeRelated.
    await tdb.pool.query("DELETE FROM post_related WHERE post_key = 'D'");
    expect(await relatedOf("D")).toBeUndefined();

    const mustNotBeCalled: EmbeddingProvider = {
      ...standInProvider(),
      async embed() {
        throw new Error("the provider must not be called to recompute an existing embedding's related list");
      },
    };
    const result = await runEmbeddingTick({ db: tdb.db, embedder: createGuardedEmbedder({ provider: mustNotBeCalled, log: () => {} }) });
    expect(result).toMatchObject({ embedded: 0, related: 1, skipped: null });
    expect(await relatedOf("D")).toBeDefined();
  });

  it("deleteSemanticRows takes 70,000 keys in one call", async () => {
    const keys = Array.from({ length: 70_000 }, (_, i) => `K-${i}`);
    await expect(tdb.db.transaction((tx) => deleteSemanticRows(tx, keys))).resolves.toBeUndefined();
  });
});

describe("startNewsApi's embedding worker", () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const c of cleanups.splice(0).reverse()) await c();
  });

  it.each([
    [true, 1],
    [false, 0],
  ])("with semanticSearch %s, workers.embed embeds %i post(s)", async (flag, count) => {
    const tdb = await createNewsTestDb();
    cleanups.push(() => tdb.drop());
    const handle = await startNewsApi(
      {
        DATABASE_URL: tdb.url,
        EVENT_SECRETS: JSON.stringify(EVENT_SECRETS),
        TENANT_CONFIG: writeTenantConfig({ features: { semanticSearch: flag, staffAi: false } }),
        EMBEDDINGS_PROVIDER: "stand-in",
      },
      { hub: false },
    );
    cleanups.push(() => closeHandle(handle));
    await tdb.db.transaction((tx) => applyRelease(tx, release("A", "alpha"), { notify: false }));
    await handle.workers.embed!();
    expect((await tdb.pool.query("SELECT count(*)::int AS n FROM post_embeddings")).rows[0].n).toBe(count);
    expect((await request(handle.app).get("/health/live")).status).toBe(200);
  });
});

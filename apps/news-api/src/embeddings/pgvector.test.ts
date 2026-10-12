import { afterEach, describe, expect, it, vi } from "vitest";
import { standInProvider } from "@gcpe/embeddings";
import { closeHandle, createNewsTestDb, createRestrictedNewsTestDb, EVENT_SECRETS, newsMigrationCount, writeTenantConfig } from "../../test/helpers";
import { startNewsApi } from "../start";
import { hasHnswIndex, hasPgvector, resolveSearchMode } from "./pgvector";

describe("resolveSearchMode", () => {
  const p = standInProvider();
  it.each([
    [{ flag: true, provider: p, pgvector: true }, "semantic", []],
    [{ flag: false, provider: p, pgvector: true }, "text", ["the semanticSearch flag"]],
    [{ flag: true, provider: null, pgvector: true }, "text", ["an embeddings provider"]],
    [{ flag: true, provider: p, pgvector: false }, "text", ["pgvector"]],
    [{ flag: true, provider: standInProvider({ dimensions: 8 }), pgvector: true }, "text", ["a 1536-dimension provider"]],
    [{ flag: false, provider: null, pgvector: false }, "text", ["the semanticSearch flag", "an embeddings provider", "pgvector"]],
  ] as const)("%o -> %s", (inputs, mode, missing) => {
    expect(resolveSearchMode(inputs)).toEqual({ mode, missing });
  });
});

describe("migrations with and without pgvector (spec §9)", () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const c of cleanups.splice(0).reverse()) await c();
    vi.restoreAllMocks();
  });
  const env = (url: string, extra: Record<string, string> = {}) => ({
    DATABASE_URL: url,
    EVENT_SECRETS: JSON.stringify(EVENT_SECRETS),
    TENANT_CONFIG: writeTenantConfig({ features: { semanticSearch: true, staffAi: false } }),
    EMBEDDINGS_PROVIDER: "stand-in",
    SLIDE_IMAGES_FETCH_BASE: "http://files.internal.test",
    ...extra,
  });

  it("every migration succeeds as a role that cannot CREATE EXTENSION, and search stays in text mode", async () => {
    const tdb = await createRestrictedNewsTestDb();
    cleanups.push(() => tdb.drop());
    const { rows } = await tdb.pool.query<{ n: number }>("SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations");
    expect(rows[0]!.n).toBe(newsMigrationCount());
    expect(await hasPgvector(tdb.db)).toBe(false);
    expect(await hasHnswIndex(tdb.db)).toBe(false);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const handle = await startNewsApi(env(tdb.url), { hub: false });
    cleanups.push(() => closeHandle(handle));
    expect(handle.searchMode).toBe("text");
    expect(warn).toHaveBeenCalledWith("[news-api] semantic search is off: missing pgvector");
  });

  it("as a role that can, pgvector and the HNSW index are created and semantic search turns on", async () => {
    const tdb = await createNewsTestDb();
    cleanups.push(() => tdb.drop());
    expect(await hasPgvector(tdb.db)).toBe(true);
    expect(await hasHnswIndex(tdb.db)).toBe(true);
    const handle = await startNewsApi(env(tdb.url), { hub: false });
    cleanups.push(() => closeHandle(handle));
    expect(handle.searchMode).toBe("semantic");
  });

  it("stays in text mode, and says why, when the flag is on but no provider is configured", async () => {
    const tdb = await createNewsTestDb();
    cleanups.push(() => tdb.drop());
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const handle = await startNewsApi(env(tdb.url, { EMBEDDINGS_PROVIDER: "" }), { hub: false });
    cleanups.push(() => closeHandle(handle));
    expect(handle.searchMode).toBe("text");
    expect(warn).toHaveBeenCalledWith("[news-api] semantic search is off: missing an embeddings provider");
  });

  it("is text mode with the flag off, without a warning", async () => {
    const tdb = await createNewsTestDb();
    cleanups.push(() => tdb.drop());
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const handle = await startNewsApi({ ...env(tdb.url), TENANT_CONFIG: writeTenantConfig({}) }, { hub: false });
    cleanups.push(() => closeHandle(handle));
    expect(handle.searchMode).toBe("text");
    expect(warn.mock.calls.flat().join(" ")).not.toMatch(/semantic search is off/);
  });
});

describe("post_embeddings.embedding length", () => {
  it("rejects a row whose embedding isn't 1536 numbers long", async () => {
    const tdb = await createNewsTestDb();
    try {
      await tdb.pool.query(
        `INSERT INTO posts (key, kind, publish_date, has_media_assets, has_translations, is_news_on_demand, documents, ministry_keys, sector_keys, tag_keys, theme_keys, index_keys, timestamp)
         VALUES ('TEST-EMBED-1', 'release', now(), false, false, false, '{}'::jsonb, '{}', '{}', '{}', '{}', '{}', now())`,
      );
      await expect(
        tdb.pool.query(
          `INSERT INTO post_embeddings (post_key, provider, model, dimensions, text_hash, embedding)
           VALUES ('TEST-EMBED-1', 'stand-in', 'stand-in-1536', 1536, 'hash', $1)`,
          [Array(8).fill(0.1)],
        ),
      ).rejects.toThrow(/post_embeddings_embedding_length_check/);
    } finally {
      await tdb.drop();
    }
  });
});

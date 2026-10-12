import { and, sql } from "drizzle-orm";
import type { SearchLanguage } from "@gcpe/config";
import type { Db, Tx } from "@gcpe/db-kit";
import { normaliseForEmbedding, type GuardedEmbedder } from "@gcpe/embeddings";
import { postEmbeddings, posts } from "../db/schema";
import { VECTOR_DIMENSIONS } from "../embeddings/pgvector";
import { SEARCH_MAX_PAGE, SEARCH_PAGE_SIZE, type SearchQuery } from "./query";
import type { SemanticSearch } from "./service";
import { READ_SNAPSHOT, searchFilters, searchRowsByKeys, textSearch } from "./text-search";
import type { QueryVectorCache } from "./vector-cache";

/** The deepest result a visitor can reach (50 pages of 20): the vector branch never needs more. */
export const VECTOR_CANDIDATE_LIMIT = SEARCH_MAX_PAGE * SEARCH_PAGE_SIZE;

/** Which slice of the vector keys, and which window of text matches, make up `page`. */
export function pageWindow(page: number, vectorCount: number): { vectorStart: number; vectorEnd: number; textOffset: number; textLimit: number } {
  const start = (page - 1) * SEARCH_PAGE_SIZE;
  const vectorStart = Math.min(start, vectorCount);
  const vectorEnd = Math.min(start + SEARCH_PAGE_SIZE, vectorCount);
  return { vectorStart, vectorEnd, textOffset: Math.max(0, start - vectorCount), textLimit: SEARCH_PAGE_SIZE - (vectorEnd - vectorStart) };
}

export interface SemanticSearchOptions {
  db: Db;
  embedder: GuardedEmbedder;
  cache: QueryVectorCache;
  language: SearchLanguage;
  defaultLanguageId: number;
  /** Cosine distance at or below which a post is a vector match (SEARCH_SEMANTIC_THRESHOLD). */
  threshold: number;
}

/**
 * Spec §5.4 semantic mode: vector matches (distance ≤ threshold, nearest first) then text matches
 * not among them, as Media Hub orders its two groups. Returns null, never throws, when the query
 * can't be embedded: the guarded embedder has already logged a real provider failure once, and
 * an open breaker or a visitor's abort isn't worth a line. The service then serves text mode.
 */
export function createSemanticSearch(o: SemanticSearchOptions): SemanticSearch {
  return {
    async search(query, signal) {
      const text = normaliseForEmbedding(query.q);
      if (text === "") return null;
      let vector = o.cache.get(text);
      if (!vector) {
        try {
          vector = (await o.embedder.embed([text], signal))[0];
        } catch {
          return null;
        }
        if (!vector || vector.length !== VECTOR_DIMENSIONS) return null;
        o.cache.set(text, vector);
      }
      const literal = `[${vector.join(",")}]`;
      return o.db.transaction(async (tx) => {
        const keys = await vectorKeys(tx, query, literal, o.threshold);
        const w = pageWindow(query.page, keys.length);
        const vectorRows = await searchRowsByKeys(tx, keys.slice(w.vectorStart, w.vectorEnd), o.defaultLanguageId);
        const textPage = await textSearch(tx, query, {
          language: o.language,
          defaultLanguageId: o.defaultLanguageId,
          excludeKeys: keys,
          window: { offset: w.textOffset, limit: w.textLimit },
        });
        return { total: keys.length + textPage.total, rows: [...vectorRows, ...textPage.rows] };
      }, READ_SNAPSHOT);
    },
  };
}

/**
 * Exact cosine distance for every post the filters allow. The MATERIALIZED CTE has no ORDER BY,
 * so the planner can't swap in the approximate HNSW index (which returns at most hnsw.ef_search
 * rows, before the filters): results never depend on the plan. post_embeddings holds published
 * posts only; searchFilters also requires is_published.
 */
async function vectorKeys(tx: Tx, query: SearchQuery, literal: string, threshold: number): Promise<string[]> {
  const { rows } = await tx.execute<{ key: string }>(sql`
    WITH scored AS MATERIALIZED (
      SELECT ${posts.key} AS key, (${postEmbeddings.embedding}::vector(1536)) <=> ${literal}::vector(1536) AS distance
      FROM ${postEmbeddings} JOIN ${posts} ON ${posts.key} = ${postEmbeddings.postKey}
      WHERE ${and(...searchFilters(query))}
    )
    SELECT key FROM scored
    WHERE distance <= ${threshold}
    ORDER BY distance, key COLLATE "C"
    LIMIT ${VECTOR_CANDIDATE_LIMIT}`);
  return rows.map((r) => r.key);
}

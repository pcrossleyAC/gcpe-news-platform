import { sql } from "drizzle-orm";
import { z } from "zod";
import type { SearchLanguage } from "@gcpe/config";
import type { Db, Tx } from "@gcpe/db-kit";
import type { GuardedEmbedder } from "@gcpe/embeddings";
import { postEmbeddings, posts } from "../db/schema";
import { VECTOR_DIMENSIONS } from "../embeddings/pgvector";
import { searchResultMapper } from "./service";
import { READ_SNAPSHOT, searchRowsByKeys, textSearch, type SearchRow } from "./text-search";

export const SIMILAR_LIMIT = 10;
export const SIMILAR_MAX_TEXT_CHARS = 8000;
export const SIMILAR_MAX_TERMS_CHARS = 1000;
const SIMILAR_MAX_TERMS = 32;

const codePoints = (s: string) => Array.from(s).length;
const noNul = (s: string) => !s.includes("\u0000");

/** Spec §7's body, plus `terms` (headline and keywords, for text mode) and `excludeKey` (the
 * release's own key). Every string is draft text: never logged, stored or echoed. */
export const similarRequestSchema = z
  .object({
    text: z.string().refine((s) => codePoints(s) <= SIMILAR_MAX_TEXT_CHARS && noNul(s)),
    terms: z.string().refine((s) => codePoints(s) <= SIMILAR_MAX_TERMS_CHARS && noNul(s)),
    mode: z.enum(["ai", "text"]),
    excludeKey: z.string().min(1).max(100).refine(noNul).optional(),
  })
  .strict();
export type SimilarRequest = z.infer<typeof similarRequestSchema>;

export type SimilarMatch = "ai" | "text";
export interface SimilarResult {
  key: string;
  headline: string | null;
  publishDate: string;
  leadMinistryKey: string | null;
  url: string;
  match: SimilarMatch;
}
export interface SimilarResponse {
  mode: SimilarMatch;
  results: SimilarResult[];
}
export interface SimilarService {
  similar(req: SimilarRequest, signal?: AbortSignal): Promise<SimilarResponse>;
}

/** The distinct words of `terms` joined with websearch_to_tsquery's `or`: a post sharing any of
 * them matches, and ts_rank_cd ranks posts sharing more of them higher. */
export function orTerms(terms: string): string {
  const words = terms.normalize("NFKC").toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  return [...new Set(words)].filter((w) => w !== "or").slice(0, SIMILAR_MAX_TERMS).join(" or ");
}

export interface SimilarServiceOptions {
  db: Db;
  timeZone: string;
  language: SearchLanguage;
  defaultLanguageId: number;
  publicSiteUrl: string;
  /** Cosine distance at or below which a post is an AI match (SEARCH_SEMANTIC_THRESHOLD). */
  threshold: number;
  /** Non-null only when this News API's staffAi flag, a provider and pgvector are all present
   * (start.ts). Null: no provider is ever called, whatever the request's mode. */
  embedder: GuardedEmbedder | null;
}

/**
 * Spec §7: up to 10 published posts like a draft. AI mode: the nearest posts within the
 * threshold, then text matches not among them. Nothing is cached or stored, and nothing here
 * logs; the guarded embedder logs a provider failure with its id and a safe label only.
 */
export function createSimilarService(o: SimilarServiceOptions): SimilarService {
  const toResult = searchResultMapper(o.publicSiteUrl, o.timeZone);
  const shape = (row: SearchRow, match: SimilarMatch): SimilarResult => {
    const { key, headline, publishDate, leadMinistryKey, url } = toResult(row);
    return { key, headline, publishDate, leadMinistryKey, url, match };
  };
  return {
    async similar(req, signal) {
      const vector = req.mode === "ai" && o.embedder ? await embedDraft(o.embedder, req.text, signal) : null;
      const mode: SimilarMatch = vector ? "ai" : "text";
      const q = orTerms(req.terms);
      return o.db.transaction(async (tx) => {
        const aiKeys = vector ? await nearestKeys(tx, `[${vector.join(",")}]`, o.threshold, req.excludeKey) : [];
        const aiRows = await searchRowsByKeys(tx, aiKeys, o.defaultLanguageId);
        const room = SIMILAR_LIMIT - aiRows.length;
        const textRows =
          q === "" || room === 0
            ? []
            : (
                await textSearch(tx, { q, page: 1 }, {
                  language: o.language,
                  defaultLanguageId: o.defaultLanguageId,
                  excludeKeys: [...aiKeys, ...(req.excludeKey ? [req.excludeKey] : [])],
                  window: { offset: 0, limit: room },
                })
              ).rows;
        return { mode, results: [...aiRows.map((r) => shape(r, "ai")), ...textRows.map((r) => shape(r, "text"))] };
      }, READ_SNAPSHOT);
    },
  };
}

/** The draft's vector, or null (blank text, a failed or refused call, a wrong-size vector). */
async function embedDraft(embedder: GuardedEmbedder, text: string, signal?: AbortSignal): Promise<number[] | null> {
  const input = text.replace(/\s+/g, " ").trim();
  if (input === "") return null;
  try {
    const [v] = await embedder.embed([input], signal);
    return v && v.length === VECTOR_DIMENSIONS ? v : null;
  } catch {
    return null;
  }
}

/** Exact cosine distance over published posts' embeddings, nearest first (as semantic.ts:
 * MATERIALIZED, so the approximate HNSW index never changes the answer). */
async function nearestKeys(tx: Tx, literal: string, threshold: number, excludeKey: string | undefined): Promise<string[]> {
  const exclude = excludeKey ? sql`AND lower(${posts.key}) <> ${excludeKey.toLowerCase()}` : sql``;
  const { rows } = await tx.execute<{ key: string }>(sql`
    WITH scored AS MATERIALIZED (
      SELECT ${posts.key} AS key, (${postEmbeddings.embedding}::vector(1536)) <=> ${literal}::vector(1536) AS distance
      FROM ${postEmbeddings} JOIN ${posts} ON ${posts.key} = ${postEmbeddings.postKey}
      WHERE ${posts.isPublished} = true ${exclude}
    )
    SELECT key FROM scored
    WHERE distance <= ${threshold}
    ORDER BY distance, key COLLATE "C"
    LIMIT ${SIMILAR_LIMIT}`);
  return rows.map((r) => r.key);
}

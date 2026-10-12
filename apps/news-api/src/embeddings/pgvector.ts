import { sql } from "drizzle-orm";
import type { DbOrTx } from "@gcpe/db-kit";
import type { EmbeddingProvider } from "@gcpe/embeddings";
import type { SearchMode } from "../search/service";

/** The dimension in migrations/0005's index expression: every stored embedding must have it. */
export const VECTOR_DIMENSIONS = 1536;
export const HNSW_INDEX_NAME = "post_embeddings_embedding_hnsw_idx";

export async function hasPgvector(db: DbOrTx): Promise<boolean> {
  const { rows } = await db.execute<{ present: boolean }>(sql`SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector') AS present`);
  return rows[0]?.present === true;
}

export async function hasHnswIndex(db: DbOrTx): Promise<boolean> {
  const { rows } = await db.execute<{ present: boolean }>(
    sql`SELECT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = current_schema() AND indexname = ${HNSW_INDEX_NAME}) AS present`,
  );
  return rows[0]?.present === true;
}

/**
 * Spec §5.3: semantic only when the tenant flag, a provider and pgvector are all present. The
 * provider must also produce VECTOR_DIMENSIONS, or the index expression would refuse its rows.
 * `missing` names what's absent, for the startup warning.
 */
export function resolveSearchMode(i: { flag: boolean; provider: EmbeddingProvider | null; pgvector: boolean }): { mode: SearchMode; missing: string[] } {
  const missing: string[] = [];
  if (!i.flag) missing.push("the semanticSearch flag");
  if (!i.provider) missing.push("an embeddings provider");
  else if (i.provider.dimensions !== VECTOR_DIMENSIONS) missing.push(`a ${VECTOR_DIMENSIONS}-dimension provider`);
  if (!i.pgvector) missing.push("pgvector");
  return { mode: missing.length === 0 ? "semantic" : "text", missing };
}

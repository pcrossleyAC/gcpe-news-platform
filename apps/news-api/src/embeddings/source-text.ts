import { createHash } from "node:crypto";

export const EMBEDDING_SOURCE_MAX_CHARS = 8000;

/**
 * Spec §5.2's source text: the first 8,000 characters (code points) of posts.search_text, which
 * already holds the headlines, summary, keywords, location, subheadlines and bodies, HTML-free.
 */
export function embeddingSourceText(searchText: string): string {
  if (searchText.length <= EMBEDDING_SOURCE_MAX_CHARS) return searchText;
  return Array.from(searchText).slice(0, EMBEDDING_SOURCE_MAX_CHARS).join("");
}

/** post_embeddings.text_hash and posts.embedding_text_hash: SHA-256 (hex) of the source text. */
export function embeddingTextHash(searchText: string): string {
  return createHash("sha256").update(embeddingSourceText(searchText), "utf8").digest("hex");
}

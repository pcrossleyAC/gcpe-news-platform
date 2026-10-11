import type { ReleaseRecord } from "@gcpe/events";
import { collapseWhitespace, htmlToPlainText } from "@gcpe/embeddings";

/**
 * Postgres refuses a tsvector over 1 MB, and search_vector is generated from this text: an
 * uncapped very long release would fail its own write. 100,000 characters stays far below that.
 */
export const SEARCH_TEXT_MAX_CHARS = 100_000;

export type SearchTextSource = Pick<ReleaseRecord, "summary" | "keywords" | "location" | "documents">;

/** posts.search_text (spec §5.1): headlines, summary, keywords, location, then subheadlines and bodies. */
export function searchTextFor(p: SearchTextSource): string {
  const parts = [
    ...p.documents.map((d) => d.headline),
    p.summary,
    p.keywords,
    p.location,
    ...p.documents.flatMap((d) => [d.subheadline, htmlToPlainText(d.detailsHtml)]),
  ];
  const text = collapseWhitespace(parts.filter((s): s is string => !!s).join(" "));
  if (text.length <= SEARCH_TEXT_MAX_CHARS) return text;
  return Array.from(text).slice(0, SEARCH_TEXT_MAX_CHARS).join("");
}

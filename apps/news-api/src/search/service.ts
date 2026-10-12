import type { SearchLanguage } from "@gcpe/config";
import type { Db } from "@gcpe/db-kit";
import { BreakerOpenError } from "@gcpe/embeddings";
import { safeErrorLabel } from "@gcpe/http-kit";
import { formatOffsetDateTime } from "../time";
import type { SearchQuery } from "./query";
import { READ_SNAPSHOT, textSearch, type SearchPage, type SearchRow } from "./text-search";

export type SearchMode = "text" | "semantic";

export interface SearchResult {
  key: string;
  kind: string;
  headline: string | null;
  summary: string | null;
  publishDate: string;
  leadMinistryKey: string | null;
  url: string;
}

export interface SearchResponse {
  mode: SearchMode;
  page: number;
  total: number;
  results: SearchResult[];
}

/** Semantic mode: the whole page, or null to fall back to text. It catches its own embed
 * failures; a throw means its SQL failed, which the service logs once. `signal` is the
 * request's own AbortSignal, passed through unchanged so a guarded embedder can treat a caller
 * abort as neutral to its breaker. Text mode may ignore it. */
export interface SemanticSearch {
  search(query: SearchQuery, signal?: AbortSignal): Promise<SearchPage | null>;
}

export interface SearchServiceOptions {
  db: Db;
  timeZone: string;
  language: SearchLanguage;
  defaultLanguageId: number;
  /** Results link to `<publicSiteUrl>/releases/<key>`. */
  publicSiteUrl: string;
  semantic?: SemanticSearch | null;
  log?: (line: string) => void;
}

export interface SearchService {
  readonly timeZone: string;
  /** `signal` is the request's own AbortSignal; only the semantic branch (6b) reads it. */
  search(query: SearchQuery, signal?: AbortSignal): Promise<SearchResponse>;
}

/** The mapper from a SearchRow to the public SearchResult shape, shared by text and semantic mode. */
export function searchResultMapper(publicSiteUrl: string, timeZone: string): (r: SearchRow) => SearchResult {
  const base = publicSiteUrl.replace(/\/+$/, "");
  return (r) => ({
    key: r.key,
    kind: r.kind,
    headline: r.headline,
    summary: r.summary,
    publishDate: formatOffsetDateTime(r.publishDate, timeZone),
    leadMinistryKey: r.leadMinistryKey,
    url: `${base}/releases/${encodeURIComponent(r.key)}`,
  });
}

export function createSearchService(o: SearchServiceOptions): SearchService {
  const log = o.log ?? ((line: string) => console.error(line));
  const toResult = searchResultMapper(o.publicSiteUrl, o.timeZone);
  return {
    timeZone: o.timeZone,
    async search(query, signal) {
      let semantic: SearchPage | null = null;
      if (o.semantic) {
        try {
          semantic = await o.semantic.search(query, signal);
        } catch (e) {
          if (!(e instanceof BreakerOpenError)) log(`[news-api] search semantic branch failed ${safeErrorLabel(e)}`);
        }
      }
      const page =
        semantic ??
        (await o.db.transaction((tx) => textSearch(tx, query, { language: o.language, defaultLanguageId: o.defaultLanguageId }), READ_SNAPSHOT));
      return { mode: semantic ? "semantic" : "text", page: query.page, total: page.total, results: page.rows.map(toResult) };
    },
  };
}

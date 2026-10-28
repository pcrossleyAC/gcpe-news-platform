import type { SearchLanguage } from "@gcpe/config";
import type { Db, Tx } from "@gcpe/db-kit";
import { BreakerOpenError } from "@gcpe/embeddings";
import { safeErrorLabel } from "@gcpe/http-kit";
import { formatOffsetDateTime } from "../time";
import { eq } from "drizzle-orm";
import { governmentTerms } from "../db/schema";
import { localDayStart, type SearchPageSize, type SearchQuery } from "./query";
import { READ_SNAPSHOT, textSearch, type SearchFacets, type SearchPage, type SearchRow, type TermWindow } from "./text-search";

export type { SearchFacets } from "./text-search";

export type SearchMode = "text" | "semantic";

export interface SearchResult {
  key: string;
  kind: string;
  headline: string | null;
  summary: string | null;
  publishDate: string;
  leadMinistryKey: string | null;
  /** Legacy's raw flags. */
  hasTranslations: boolean;
  hasMediaAssets: boolean;
  /** Whether the release page has a translation list / media-asset list to link to: what a result card shows its links by. */
  hasTranslationList: boolean;
  hasMediaAssetList: boolean;
  url: string;
}

export interface SearchResponse {
  mode: SearchMode;
  page: number;
  pageSize: SearchPageSize;
  total: number;
  results: SearchResult[];
  /** Text mode with `facets=1` only; otherwise null. */
  facets: SearchFacets | null;
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
    hasTranslations: r.hasTranslations,
    hasMediaAssets: r.hasMediaAssets,
    hasTranslationList: r.hasTranslationList,
    hasMediaAssetList: r.hasMediaAssetList,
    url: `${base}/releases/${encodeURIComponent(r.key)}`,
  });
}

/** The published government terms as publish-date windows in the tenant's zone (none before the first snapshot). */
async function termWindows(tx: Tx, timeZone: string): Promise<TermWindow[]> {
  const [row] = await tx.select({ document: governmentTerms.document }).from(governmentTerms).where(eq(governmentTerms.id, 1));
  return (row?.document.terms ?? []).map((t) => ({
    slug: t.slug,
    from: localDayStart(t.startDate, timeZone, 0),
    toExclusive: t.endDate ? localDayStart(t.endDate, timeZone, 1) : null,
  }));
}

export function createSearchService(o: SearchServiceOptions): SearchService {
  const log = o.log ?? ((line: string) => console.error(line));
  const toResult = searchResultMapper(o.publicSiteUrl, o.timeZone);
  return {
    timeZone: o.timeZone,
    async search(query, signal) {
      let semantic: SearchPage | null = null;
      // A filter-only search (no text) has nothing to embed: straight to text mode's date order.
      if (o.semantic && query.q !== "") {
        try {
          semantic = await o.semantic.search(query, signal);
        } catch (e) {
          if (!(e instanceof BreakerOpenError)) log(`[news-api] search semantic branch failed ${safeErrorLabel(e)}`);
        }
      }
      const page =
        semantic ??
        (await o.db.transaction(async (tx) => {
          const facets = query.facets ? { terms: await termWindows(tx, o.timeZone) } : undefined;
          return textSearch(tx, query, { language: o.language, defaultLanguageId: o.defaultLanguageId, facets });
        }, READ_SNAPSHOT));
      return {
        mode: semantic ? "semantic" : "text",
        page: query.page,
        pageSize: query.pageSize,
        total: page.total,
        results: page.rows.map(toResult),
        facets: semantic ? null : (page.facets ?? null),
      };
    },
  };
}

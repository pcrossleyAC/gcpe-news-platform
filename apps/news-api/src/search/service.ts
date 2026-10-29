import type { SearchLanguage } from "@gcpe/config";
import type { Db, Tx } from "@gcpe/db-kit";
import { BreakerOpenError } from "@gcpe/embeddings";
import { safeErrorLabel } from "@gcpe/http-kit";
import { formatOffsetDateTime } from "../time";
import { eq } from "drizzle-orm";
import { ConcurrencyGate, type GateOptions } from "./concurrency-gate";
import { ResultCache, type ResultCacheOptions } from "./result-cache";
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
  /** Set only when the semantic cap sent this request to text mode. The route turns it into
   * the X-Search-Fallback header and leaves it out of the body. */
  fallback?: "capacity";
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
  /** Keep anonymous public results briefly. Absent: no cache. This service only ever answers the
   * public, unauthenticated search route, so every entry is the same for every visitor. */
  cache?: ResultCacheOptions;
  /** Cap on concurrent vector scans; over it a request is answered in text mode. Absent: no cap. */
  semanticGate?: GateOptions;
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

/** The cache key: every field that changes the answer. Whitespace is collapsed, case is kept
 * (websearch syntax reads an upper-case OR as an operator). */
export function searchCacheKey(q: SearchQuery): string {
  return JSON.stringify([q.q.replace(/\s+/gu, " ").trim(), q.ministry?.toLowerCase() ?? null, q.sector?.toLowerCase() ?? null, q.type ?? null, q.from?.getTime() ?? null, q.toExclusive?.getTime() ?? null, q.page, q.pageSize, q.facets === true]);
}

export function createSearchService(o: SearchServiceOptions): SearchService {
  const log = o.log ?? ((line: string) => console.error(line));
  const toResult = searchResultMapper(o.publicSiteUrl, o.timeZone);
  const gate = o.semantic && o.semanticGate ? new ConcurrencyGate(o.semanticGate) : null;
  const cache = o.cache && o.cache.ttlMs > 0 ? new ResultCache<SearchResponse>(o.cache) : null;
  const inflight = new Map<string, { promise: Promise<SearchResponse>; controller: AbortController; waiters: number }>();

  /** The answer and whether it is the full, normal answer for this query (so cacheable). */
  async function compute(query: SearchQuery, signal?: AbortSignal): Promise<{ response: SearchResponse; complete: boolean }> {
    let semantic: SearchPage | null = null;
    let capacity = false;
    const wantsSemantic = !!o.semantic && query.q !== "";
    // A filter-only search (no text) has nothing to embed: straight to text mode's date order.
    if (wantsSemantic) {
      const release = gate ? await gate.acquire(signal) : () => {};
      if (!release) {
        capacity = true;
      } else {
        try {
          semantic = await o.semantic!.search(query, signal);
        } catch (e) {
          if (!(e instanceof BreakerOpenError)) log(`[news-api] search semantic branch failed ${safeErrorLabel(e)}`);
        } finally {
          release();
        }
      }
    }
    const page =
      semantic ??
      (await o.db.transaction(async (tx) => {
        const facets = query.facets ? { terms: await termWindows(tx, o.timeZone) } : undefined;
        return textSearch(tx, query, { language: o.language, defaultLanguageId: o.defaultLanguageId, facets });
      }, READ_SNAPSHOT));
    const response: SearchResponse = {
      mode: semantic ? "semantic" : "text",
      page: query.page,
      pageSize: query.pageSize,
      total: page.total,
      results: page.rows.map(toResult),
      facets: semantic ? null : (page.facets ?? null),
    };
    if (capacity) response.fallback = "capacity";
    // Text mode for a query that should have been semantic (cap, open breaker, embed failure,
    // failed vector SQL) is a degraded answer: not kept, so the next visitor gets the real one.
    return { response, complete: !(wantsSemantic && !semantic) };
  }

  /** One computation per distinct key at a time. It is aborted only when every waiter has gone. */
  function shared(key: string, query: SearchQuery, signal?: AbortSignal): Promise<SearchResponse> {
    let f = inflight.get(key);
    if (!f) {
      const controller = new AbortController();
      const entry = { controller, waiters: 0, promise: undefined as unknown as Promise<SearchResponse> };
      entry.promise = compute(query, controller.signal)
        .then(({ response, complete }) => {
          if (complete && cache) cache.set(key, Object.freeze(response), 2 * JSON.stringify(response).length);
          return response;
        })
        .finally(() => {
          if (inflight.get(key) === entry) inflight.delete(key);
        });
      inflight.set(key, entry);
      f = entry;
    }
    const flight = f;
    flight.waiters++;
    const onAbort = () => {
      if (--flight.waiters === 0) {
        flight.controller.abort();
        // An aborted flight may finish degraded: a new identical request starts its own.
        if (inflight.get(key) === flight) inflight.delete(key);
      }
    };
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });
    return flight.promise.finally(() => signal?.removeEventListener("abort", onAbort));
  }

  return {
    timeZone: o.timeZone,
    async search(query, signal) {
      if (!cache) return (await compute(query, signal)).response;
      const key = searchCacheKey(query);
      return cache.get(key) ?? (await shared(key, query, signal));
    },
  };
}

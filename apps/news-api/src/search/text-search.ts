import { and, arrayContains, desc, eq, gte, inArray, lt, sql, type SQL } from "drizzle-orm";
import type { SearchLanguage } from "@gcpe/config";
import type { DbOrTx } from "@gcpe/db-kit";
import type { PostKind } from "@gcpe/events";
import { posts } from "../db/schema";
import type { SearchQuery } from "./query";

export interface SearchRow {
  key: string;
  kind: string;
  headline: string | null;
  summary: string | null;
  publishDate: Date;
  leadMinistryKey: string | null;
  hasTranslations: boolean;
  hasMediaAssets: boolean;
}

export interface FacetCount<K extends string = string> {
  key: K;
  count: number;
}

/** Counts of the filtered result set, each list biggest first (then by key), zero counts left out. */
export interface SearchFacets {
  ministries: FacetCount[];
  sectors: FacetCount[];
  types: FacetCount<PostKind>[];
  terms: { slug: string; count: number }[];
}

/** A government term as a publish-date window: [from, toExclusive), the latter null while current. */
export interface TermWindow {
  slug: string;
  from: Date;
  toExclusive: Date | null;
}

export interface SearchPage {
  total: number;
  rows: SearchRow[];
  /** Only text mode computes facets, and only when asked (`facets` option). */
  facets?: SearchFacets;
}

export interface TextSearchOptions {
  language: SearchLanguage;
  /** Picks the headline: this language's document, else the first. */
  defaultLanguageId: number;
  /** Keys to leave out, case-insensitively. 6b's text branch passes the vector branch's keys. */
  excludeKeys?: string[];
  /** Which matches to return; default: the query's page. Semantic mode passes what's left of a page. */
  window?: { offset: number; limit: number };
  /** Also count the facets over the same where as the results; the windows are the government terms'. */
  facets?: { terms: TermWindow[] };
}

/** Count and page from one snapshot: a publish between them can't skew total. */
export const READ_SNAPSHOT = { isolationLevel: "repeatable read", accessMode: "read only" } as const;

const KEY_DESC = sql`${posts.key} collate "C" desc`;

/** Published posts matching the query's filters. Shared with 6b's vector branch. */
export function searchFilters(query: SearchQuery): SQL[] {
  const conds: SQL[] = [eq(posts.isPublished, true)];
  if (query.ministry) conds.push(arrayContains(posts.indexKeys, [`ministries:${query.ministry.toLowerCase()}`]));
  if (query.sector) conds.push(arrayContains(posts.indexKeys, [`sectors:${query.sector.toLowerCase()}`]));
  if (query.type) conds.push(eq(posts.kind, query.type));
  if (query.from) conds.push(gte(posts.publishDate, query.from));
  if (query.toExclusive) conds.push(lt(posts.publishDate, query.toExclusive));
  return conds;
}

/** The columns of a SearchRow. The headline is the default-language document's, else the first,
 * picked in SQL so a page never detoasts every result's full `documents` jsonb. */
export function searchRowColumns(defaultLanguageId: number) {
  return {
    key: posts.key,
    kind: posts.kind,
    headline: sql<string | null>`coalesce(
      (select doc->>'headline' from jsonb_array_elements(${posts.documents}) with ordinality as t(doc, ord)
        where (doc->>'languageId')::int = ${defaultLanguageId} order by ord limit 1),
      ${posts.documents}->0->>'headline'
    )`,
    summary: posts.summary,
    publishDate: posts.publishDate,
    leadMinistryKey: posts.leadMinistryKey,
    hasTranslations: posts.hasTranslations,
    hasMediaAssets: posts.hasMediaAssets,
  };
}

/** Published posts with these stored keys, in the given order. For short lists (a page, a related list). */
export async function searchRowsByKeys(db: DbOrTx, keys: string[], defaultLanguageId: number): Promise<SearchRow[]> {
  if (keys.length === 0) return [];
  const rows = await db.select(searchRowColumns(defaultLanguageId)).from(posts).where(and(inArray(posts.key, keys), eq(posts.isPublished, true)));
  const byKey = new Map(rows.map((r) => [r.key, r]));
  return keys.map((k) => byKey.get(k)).filter((r): r is SearchRow => r !== undefined);
}

const byCountThenKey = (a: { count: number }, b: { count: number }, ka: string, kb: string) => b.count - a.count || (ka < kb ? -1 : ka > kb ? 1 : 0);

/**
 * Facet counts over `where`, the very condition the results use, in one statement: the filtered
 * posts are materialised once, then counted per ministry, sector, kind and government term.
 * A post counts once per facet value (count distinct key), so a repeated ministry key can't double.
 * Index keys are stored lowercased, so ministry and sector facet keys are lowercase.
 */
async function facetCounts(db: DbOrTx, where: SQL | undefined, windows: TermWindow[]): Promise<SearchFacets> {
  const indexed = (facet: string, prefix: string) => sql`
    SELECT ${facet}::text AS facet, substr(k, ${prefix.length + 1}) AS key, count(DISTINCT f.key)::int AS n
    FROM f CROSS JOIN LATERAL unnest(f.index_keys) AS k
    WHERE starts_with(k, ${prefix}) GROUP BY 2`;
  const parts = [
    indexed("ministry", "ministries:"),
    indexed("sector", "sectors:"),
    sql`SELECT 'type'::text, kind, count(*)::int FROM f GROUP BY kind`,
  ];
  if (windows.length > 0) {
    const counts = windows.map((w) => sql`count(*) FILTER (WHERE f.publish_date >= ${w.from.toISOString()}::timestamptz${w.toExclusive ? sql` AND f.publish_date < ${w.toExclusive.toISOString()}::timestamptz` : sql``})::int`);
    const values = windows.map((w, i) => sql`(${w.slug}::text, c.c${sql.raw(String(i))})`);
    parts.push(sql`SELECT 'term'::text, v.slug, v.n FROM (SELECT ${sql.join(counts.map((c, i) => sql`${c} AS ${sql.raw(`c${i}`)}`), sql`, `)} FROM f) c CROSS JOIN LATERAL (VALUES ${sql.join(values, sql`, `)}) AS v(slug, n)`);
  }
  const { rows } = await db.execute<{ facet: string; key: string; n: number }>(sql`
    WITH f AS MATERIALIZED (SELECT ${posts.key} AS key, ${posts.kind} AS kind, ${posts.publishDate} AS publish_date, ${posts.indexKeys} AS index_keys FROM ${posts} WHERE ${where})
    ${sql.join(parts.map((p) => sql`(${p})`), sql` UNION ALL `)}`);
  const list = (facet: string) =>
    rows
      .filter((r) => r.facet === facet && r.n > 0)
      .map((r) => ({ key: r.key, count: Number(r.n) }))
      .sort((a, b) => byCountThenKey(a, b, a.key, b.key));
  return {
    ministries: list("ministry"),
    sectors: list("sector"),
    types: list("type") as FacetCount<PostKind>[],
    terms: list("term").map((t) => ({ slug: t.key, count: t.count })),
  };
}

/** Spec §5.4 text mode: websearch_to_tsquery against search_vector, ts_rank_cd, then newest first.
 * An empty `q` (a filter-only search) matches every post the filters allow, newest first. */
export async function textSearch(db: DbOrTx, query: SearchQuery, opts: TextSearchOptions): Promise<SearchPage> {
  const tsquery = query.q === "" ? null : sql`websearch_to_tsquery(${opts.language}::regconfig, ${query.q})`;
  const conds = [...searchFilters(query)];
  if (tsquery) conds.push(sql`${posts.searchVector} @@ ${tsquery}`);
  const excluded = (opts.excludeKeys ?? []).map((k) => k.toLowerCase());
  if (excluded.length > 0) conds.push(sql`lower(${posts.key}) NOT IN (${sql.join(excluded.map((k) => sql`${k}`), sql`, `)})`);
  const where = and(...conds);

  const window = opts.window ?? { offset: (query.page - 1) * query.pageSize, limit: query.pageSize };
  const [{ total } = { total: 0 }] = await db.select({ total: sql<number>`count(*)::int` }).from(posts).where(where);
  const facets = opts.facets ? await facetCounts(db, where, opts.facets.terms) : undefined;
  const withFacets = <T extends SearchPage>(page: T): SearchPage => (facets ? { ...page, facets } : page);
  if (total === 0 || window.limit === 0) return withFacets({ total, rows: [] });
  const rows = await db
    .select(searchRowColumns(opts.defaultLanguageId))
    .from(posts)
    .where(where)
    .orderBy(...(tsquery ? [sql`ts_rank_cd(${posts.searchVector}, ${tsquery}) desc`] : []), desc(posts.publishDate), KEY_DESC)
    .limit(window.limit)
    .offset(window.offset);
  return withFacets({ total, rows });
}

import { and, arrayContains, desc, eq, gte, lt, sql, type SQL } from "drizzle-orm";
import type { SearchLanguage } from "@gcpe/config";
import type { Db } from "@gcpe/db-kit";
import { posts } from "../db/schema";
import { SEARCH_PAGE_SIZE, type SearchQuery } from "./query";

export interface SearchRow {
  key: string;
  kind: string;
  headline: string | null;
  summary: string | null;
  publishDate: Date;
  leadMinistryKey: string | null;
}

export interface SearchPage {
  total: number;
  rows: SearchRow[];
}

export interface TextSearchOptions {
  language: SearchLanguage;
  /** Picks the headline: this language's document, else the first. */
  defaultLanguageId: number;
  /** Keys to leave out, case-insensitively. 6b's text branch passes the vector branch's keys. */
  excludeKeys?: string[];
}

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

/** Spec §5.4 text mode: websearch_to_tsquery against search_vector, ts_rank_cd, then newest first. */
export async function textSearch(db: Db, query: SearchQuery, opts: TextSearchOptions): Promise<SearchPage> {
  const tsquery = sql`websearch_to_tsquery(${opts.language}::regconfig, ${query.q})`;
  const conds = [...searchFilters(query), sql`${posts.searchVector} @@ ${tsquery}`];
  const excluded = (opts.excludeKeys ?? []).map((k) => k.toLowerCase());
  if (excluded.length > 0) conds.push(sql`lower(${posts.key}) NOT IN (${sql.join(excluded.map((k) => sql`${k}`), sql`, `)})`);
  const where = and(...conds);

  const [{ total } = { total: 0 }] = await db.select({ total: sql<number>`count(*)::int` }).from(posts).where(where);
  if (total === 0) return { total: 0, rows: [] };
  // The default-language document's headline, else the first document's, picked in SQL so a
  // page of results never detoasts every result's full `documents` jsonb (bodies included) just
  // to read one headline each.
  const headline = sql<string | null>`coalesce(
      (select doc->>'headline' from jsonb_array_elements(${posts.documents}) with ordinality as t(doc, ord)
        where (doc->>'languageId')::int = ${opts.defaultLanguageId} order by ord limit 1),
      ${posts.documents}->0->>'headline'
    )`;
  const rows = await db
    .select({
      key: posts.key,
      kind: posts.kind,
      headline,
      summary: posts.summary,
      publishDate: posts.publishDate,
      leadMinistryKey: posts.leadMinistryKey,
    })
    .from(posts)
    .where(where)
    .orderBy(sql`ts_rank_cd(${posts.searchVector}, ${tsquery}) desc`, desc(posts.publishDate), KEY_DESC)
    .limit(SEARCH_PAGE_SIZE)
    .offset((query.page - 1) * SEARCH_PAGE_SIZE);
  return { total, rows };
}

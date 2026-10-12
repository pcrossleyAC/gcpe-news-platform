import { and, arrayOverlaps, desc, eq, sql } from "drizzle-orm";
import type { Db } from "@gcpe/db-kit";
import { postRelated, posts } from "../db/schema";
import { RELATED_LIMIT } from "../embeddings/worker";
import { searchResultMapper, type SearchMode, type SearchResult } from "./service";
import { searchRowColumns, searchRowsByKeys } from "./text-search";

export const RELATED_MAX_KEY_CHARS = 200;

export interface RelatedResponse {
  mode: SearchMode;
  results: SearchResult[];
}

export interface RelatedService {
  /** null: no published post has this key (case-insensitive). */
  related(key: string): Promise<RelatedResponse | null>;
}

export interface RelatedServiceOptions {
  db: Db;
  timeZone: string;
  defaultLanguageId: number;
  publicSiteUrl: string;
  /** The startup search mode is semantic: only then are stored lists served. */
  semantic: boolean;
}

/**
 * Spec §5.4: up to 5 posts from post_related, filtered to what is published now (another post's
 * list is only recomputed when that post is re-embedded). With no list, an emptied list, or
 * semantic mode off: the newest published posts sharing the lead ministry and at least one tag.
 */
export function createRelatedService(o: RelatedServiceOptions): RelatedService {
  const toResult = searchResultMapper(o.publicSiteUrl, o.timeZone);
  return {
    async related(key) {
      const [post] = await o.db
        .select({ key: posts.key, lead: posts.leadMinistryKey, tagKeys: posts.tagKeys })
        .from(posts)
        .where(and(sql`lower(${posts.key}) = lower(${key})`, eq(posts.isPublished, true)));
      if (!post) return null;
      if (o.semantic) {
        const [row] = await o.db.select({ keys: postRelated.relatedKeys }).from(postRelated).where(eq(postRelated.postKey, post.key));
        if (row) {
          const rows = (await searchRowsByKeys(o.db, row.keys, o.defaultLanguageId)).slice(0, RELATED_LIMIT);
          if (rows.length > 0) return { mode: "semantic", results: rows.map(toResult) };
        }
      }
      if (!post.lead || post.tagKeys.length === 0) return { mode: "text", results: [] };
      const rows = await o.db
        .select(searchRowColumns(o.defaultLanguageId))
        .from(posts)
        .where(
          and(
            eq(posts.isPublished, true),
            sql`lower(${posts.key}) <> lower(${post.key})`,
            sql`lower(${posts.leadMinistryKey}) = lower(${post.lead})`,
            arrayOverlaps(posts.indexKeys, post.tagKeys.map((t) => `tags:${t.toLowerCase()}`)),
          ),
        )
        .orderBy(desc(posts.publishDate), sql`${posts.key} collate "C" desc`)
        .limit(RELATED_LIMIT);
      return { mode: "text", results: rows.map(toResult) };
    },
  };
}

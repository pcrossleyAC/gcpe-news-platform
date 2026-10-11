import { sql } from "drizzle-orm";
import type { SearchLanguage } from "@gcpe/config";
import type { Db } from "@gcpe/db-kit";

/** The text-search configuration posts.search_vector is generated with, or null if there is no such column. */
export async function searchVectorLanguage(db: Db): Promise<string | null> {
  const { rows } = await db.execute<{ expr: string }>(sql`
    SELECT pg_get_expr(d.adbin, d.adrelid) AS expr
    FROM pg_attrdef d
    JOIN pg_attribute a ON a.attrelid = d.adrelid AND a.attnum = d.adnum
    WHERE d.adrelid = 'posts'::regclass AND a.attname = 'search_vector'`);
  return rows[0]?.expr.match(/to_tsvector\('([^']+)'::regconfig/)?.[1] ?? null;
}

/** Spec §5.1: queries must use the column's own configuration, so a mismatch refuses to start. */
export async function assertSearchLanguage(db: Db, expected: SearchLanguage): Promise<void> {
  const actual = await searchVectorLanguage(db);
  if (actual !== expected) {
    throw new Error(
      `Tenant search.language is "${expected}" but posts.search_vector uses "${actual ?? "(none)"}". ` +
        `Change one to match: see docs/deploy/siteground.md, "Search and embeddings".`,
    );
  }
}

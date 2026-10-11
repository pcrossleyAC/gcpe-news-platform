/**
 * `npm run news-api:search-backfill` (spec §5.1): fills posts.search_text for rows written
 * before the column existed. Dry run by default; `--confirm` to write; `--all` to recompute
 * every row rather than only the empty ones. Each batch locks its rows, so a post rewritten by
 * an event mid-run keeps the text its own write computed. Safe to re-run.
 */
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { and, sql } from "drizzle-orm";
import { z } from "zod";
import { parseEnv } from "@gcpe/config";
import { createDb, type Db } from "@gcpe/db-kit";
import { safeErrorLabel } from "@gcpe/http-kit";
import { posts } from "../db/schema";
import { searchTextFor } from "../search/search-text";

const DEFAULT_BATCH_SIZE = 200;
const USAGE = "Usage: npm run news-api:search-backfill -- [--all] [--confirm]";

export interface SearchBackfillOptions {
  confirm: boolean;
  all: boolean;
  batchSize?: number;
}

export interface SearchBackfillResult {
  confirmed: boolean;
  all: boolean;
  missingColumn: boolean;
  total: number;
  pending: number;
  filled: number;
  /** safeErrorLabel of the batch that stopped the run, or null. */
  failure: string | null;
}

export async function searchBackfill(db: Db, opts: SearchBackfillOptions): Promise<SearchBackfillResult> {
  const base = { confirmed: opts.confirm, all: opts.all, total: 0, pending: 0, filled: 0, failure: null };
  const { rows: columns } = await db.execute(sql`
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = 'posts' AND column_name = 'search_text'`);
  if (columns.length === 0) return { ...base, missingColumn: true };

  const scope = opts.all ? sql`true` : sql`${posts.searchText} IS NULL`;
  let total: number;
  let pending: number;
  try {
    [{ total } = { total: 0 }] = await db.select({ total: sql<number>`count(*)::int` }).from(posts);
    [{ pending } = { pending: 0 }] = await db.select({ pending: sql<number>`count(*)::int` }).from(posts).where(scope);
  } catch (e) {
    return { ...base, missingColumn: false, failure: safeErrorLabel(e) };
  }
  const counted = { ...base, missingColumn: false, total, pending };
  if (!opts.confirm) return counted;

  const size = opts.batchSize ?? DEFAULT_BATCH_SIZE;
  let after = "";
  let filled = 0;
  for (;;) {
    let done: number;
    try {
      done = await db.transaction(async (tx) => {
        const rows = await tx
          .select({ key: posts.key, summary: posts.summary, keywords: posts.keywords, location: posts.location, documents: posts.documents })
          .from(posts)
          .where(and(scope, sql`${posts.key} COLLATE "C" > ${after}`))
          .orderBy(sql`${posts.key} COLLATE "C"`)
          .limit(size)
          .for("update");
        if (rows.length === 0) return 0;
        const values = rows.map((r) => ({ key: r.key, text: searchTextFor(r) }));
        await tx.execute(sql`
          UPDATE posts SET search_text = v.text
          FROM jsonb_to_recordset(${JSON.stringify(values)}::jsonb) AS v(key text, text text)
          WHERE posts.key = v.key`);
        after = rows[rows.length - 1]!.key;
        return rows.length;
      });
    } catch (e) {
      return { ...counted, filled, failure: safeErrorLabel(e) };
    }
    if (done === 0) break;
    filled += done;
  }
  return { ...counted, filled };
}

export function parseBackfillArgs(argv: string[]): { confirm: boolean; all: boolean } {
  for (const arg of argv) {
    if (arg !== "--confirm" && arg !== "--all") throw new Error(`Unknown argument: ${arg}. ${USAGE}`);
  }
  return { confirm: argv.includes("--confirm"), all: argv.includes("--all") };
}

export function printBackfillResult(r: SearchBackfillResult, log: (s: string) => void = console.log): void {
  if (r.missingColumn) {
    log("posts.search_text doesn't exist yet: start the News API once (it runs migrations), then re-run.");
    return;
  }
  if (!r.confirmed) {
    log(`Would fill search text for ${r.pending} of ${r.total} post(s).`);
    log("Dry run: nothing written. Re-run with --confirm to write.");
    return;
  }
  log(`Filled search text for ${r.filled} of ${r.pending} post(s).`);
  if (r.failure) log(`Stopped: ${r.failure}. Re-run to continue.`);
}

async function main(): Promise<void> {
  let args: { confirm: boolean; all: boolean };
  try {
    args = parseBackfillArgs(process.argv.slice(2));
  } catch (e) {
    console.error(e instanceof Error ? e.message : USAGE);
    process.exitCode = 1;
    return;
  }
  const env = parseEnv(z.object({ DATABASE_URL: z.string().url() }));
  const { db, pool } = createDb(env.DATABASE_URL);
  try {
    const result = await searchBackfill(db, args);
    printBackfillResult(result);
    if (result.missingColumn || result.failure) process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

if (pathToFileURL(realpathSync(process.argv[1]!)).href === import.meta.url) {
  main().catch((e) => {
    console.error(safeErrorLabel(e));
    process.exitCode = 1;
  });
}

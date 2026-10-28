import { sql } from "drizzle-orm";
import type { Db, DbOrTx } from "@gcpe/db-kit";
import type { CategoryKind, ReleaseRecord } from "@gcpe/events";
import { recordChanges } from "../changes";
import { publicImportPosts } from "../db/schema";
import { deleteSemanticRows } from "../embeddings/rows";
import { applyRelease } from "../projections";
import { parseOffsetDateTime } from "../time";
import { fetchPublicSlice, type FetchedSlice, type PublicApiClient } from "./public-fetch";
import type { PublicImportCliOptions } from "./public-options";

/**
 * The write side of `import:public`. Posts go through the legacy importer's own write path —
 * `applyRelease(tx, record, { notify: false, origin: "legacy" })`, one transaction per post — so
 * an imported row is column-for-column what `import:legacy` would have written, and the same
 * `post.upserted` change row is recorded for the public site's change feed. Like the legacy
 * importer, nothing here enqueues an event: no `outbox_events` row (so no `site.rebuild_requested`
 * doorbell, no NRMS/NoD/distribution delivery) and no PostUpdate NOTIFY. The site picks the
 * changes up on its next `site.sync` poll of `/api/v2/changes`.
 *
 * Ownership: `public_import_posts` lists every key this importer created. A key already in
 * `posts` but not in that table (NRMS-published or legacy-imported) is never touched.
 */

export type UnknownCategoryKeys = Record<CategoryKind, Record<string, number>>;

export interface PublicImportResult {
  created: number;
  updated: number;
  /** Ours already, with the same timestamp: nothing written. */
  unchanged: number;
  /** Already in the News API and not created by this importer: left alone. */
  skippedExisting: string[];
  /** Ours once, but NRMS has since published the key (origin "event"): left alone. */
  skippedEventOwned: string[];
  /** Category keys the posts carry that the target DB has no category for (key → posts). Imported as given. */
  unknownCategoryKeys: UnknownCategoryKeys;
}

const FIELD: Record<CategoryKind, "ministryKeys" | "sectorKeys" | "themeKeys" | "tagKeys"> = {
  ministries: "ministryKeys",
  sectors: "sectorKeys",
  themes: "themeKeys",
  tags: "tagKeys",
};

/** The same per-key lock `applyRelease` takes (advisory xact locks re-enter within one transaction). */
async function lockPostKey(tx: DbOrTx, key: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${"posts"} || ':' || lower(${key})))`);
}

async function hasTrackingTable(db: DbOrTx): Promise<boolean> {
  const { rows } = await db.execute<{ t: string | null }>(sql`select to_regclass('public.public_import_posts')::text as t`);
  return rows[0]?.t != null;
}

/** Category keys of `records` the target DB doesn't know, per kind (key as the post gives it → number of posts). */
export async function findUnknownCategoryKeys(db: DbOrTx, records: ReleaseRecord[]): Promise<UnknownCategoryKeys> {
  const { rows } = await db.execute<{ kind: string; key: string }>(sql`select kind, lower(key) as key from categories`);
  const known = new Set(rows.map((r) => `${r.kind}:${r.key}`));
  const unknown: UnknownCategoryKeys = { ministries: {}, sectors: {}, themes: {}, tags: {} };
  for (const r of records) {
    for (const kind of Object.keys(FIELD) as CategoryKind[]) {
      for (const key of new Set(r[FIELD[kind]])) {
        if (!known.has(`${kind}:${key.toLowerCase()}`)) unknown[kind][key] = (unknown[kind][key] ?? 0) + 1;
      }
    }
  }
  return unknown;
}

type Existing = { key: string; origin: "legacy" | "event"; timestamp: Date; ours: boolean };

async function existingPost(db: DbOrTx, key: string, tracked: boolean): Promise<Existing | undefined> {
  const { rows } = tracked
    ? await db.execute<Existing>(sql`
        select p.key, p.origin, p.timestamp, (i.key is not null) as ours
        from posts p left join public_import_posts i on i.key = p.key
        where lower(p.key) = lower(${key})`)
    : await db.execute<Existing>(sql`select key, origin, timestamp, false as ours from posts where lower(key) = lower(${key})`);
  const row = rows[0];
  return row ? { ...row, timestamp: new Date(row.timestamp) } : undefined;
}

export type PlannedAction = "create" | "update" | "unchanged" | "skip-existing" | "skip-event-owned";

function decide(existing: Existing | undefined, r: ReleaseRecord): PlannedAction {
  if (!existing) return "create";
  if (!existing.ours) return "skip-existing";
  if (existing.origin === "event") return "skip-event-owned";
  return existing.timestamp.getTime() === parseOffsetDateTime(r.timestamp).getTime() ? "unchanged" : "update";
}

function emptyResult(): PublicImportResult {
  return { created: 0, updated: 0, unchanged: 0, skippedExisting: [], skippedEventOwned: [], unknownCategoryKeys: { ministries: {}, sectors: {}, themes: {}, tags: {} } };
}

function count(result: PublicImportResult, action: PlannedAction, key: string): void {
  if (action === "create") result.created++;
  else if (action === "update") result.updated++;
  else if (action === "unchanged") result.unchanged++;
  else if (action === "skip-existing") result.skippedExisting.push(key);
  else result.skippedEventOwned.push(key);
}

/** What `importPublicPosts` would do, read-only (for `--dry-run` with a database). */
export async function planPublicImport(db: Db, records: ReleaseRecord[]): Promise<PublicImportResult> {
  const result = emptyResult();
  const tracked = await hasTrackingTable(db);
  for (const r of records) count(result, decide(await existingPost(db, r.key, tracked), r), r.key);
  result.unknownCategoryKeys = await findUnknownCategoryKeys(db, records);
  return result;
}

export async function importPublicPosts(db: Db, records: ReleaseRecord[], opts: { log?: (msg: string) => void } = {}): Promise<PublicImportResult> {
  const log = opts.log ?? (() => {});
  if (!(await hasTrackingTable(db))) throw new Error("public_import_posts does not exist: apply the News API migrations first (start the News API, or run without --dry-run from a checkout)");
  const result = emptyResult();
  for (const r of records) {
    const action = await db.transaction(async (tx) => {
      await lockPostKey(tx, r.key);
      const planned = decide(await existingPost(tx, r.key, true), r);
      if (planned !== "create" && planned !== "update") return planned;
      // The record already carries indexKeys' inputs as given: unknown category keys are kept.
      const { skippedEventOwned } = await applyRelease(tx, r, { notify: false, origin: "legacy" });
      if (skippedEventOwned) return "skip-event-owned" as const;
      const stored = await existingPost(tx, r.key, true);
      await tx.insert(publicImportPosts).values({ key: stored!.key }).onConflictDoNothing();
      return planned;
    });
    count(result, action, r.key);
  }
  result.unknownCategoryKeys = await findUnknownCategoryKeys(db, records);
  log(`[import:public] created ${result.created}, updated ${result.updated}, unchanged ${result.unchanged}, skipped ${result.skippedExisting.length} existing + ${result.skippedEventOwned.length} NRMS-owned`);
  return result;
}

export interface PublicRemoveResult {
  /** Posts deleted (each recorded as `post.unpublished`, so the site drops its page). */
  removed: string[];
  /** Created here, but NRMS has since published the key: kept, and no longer tracked. */
  keptEventOwned: string[];
}

/** Lists what `removePublicPosts` would do, read-only. */
export async function planPublicRemove(db: Db): Promise<PublicRemoveResult> {
  if (!(await hasTrackingTable(db))) return { removed: [], keptEventOwned: [] };
  const { rows } = await db.execute<{ key: string; origin: string }>(sql`select p.key, p.origin from public_import_posts i join posts p on p.key = i.key order by p.key`);
  return { removed: rows.filter((r) => r.origin !== "event").map((r) => r.key), keptEventOwned: rows.filter((r) => r.origin === "event").map((r) => r.key) };
}

/**
 * Deletes every post this importer created, in one transaction with its `post.unpublished`
 * change rows: the site's rebuild of `post:<key>` finds no post, removes the page and rebuilds
 * the lists it was on. A tracked key NRMS has since published (origin "event") is kept.
 */
export async function removePublicPosts(db: Db): Promise<PublicRemoveResult> {
  if (!(await hasTrackingTable(db))) return { removed: [], keptEventOwned: [] };
  return db.transaction(async (tx) => {
    const { rows } = await tx.execute<{ key: string }>(sql`
      DELETE FROM posts WHERE key IN (SELECT key FROM public_import_posts) AND origin = 'legacy'
      RETURNING key`);
    const removed = rows.map((r) => r.key).sort();
    await deleteSemanticRows(tx, removed);
    await recordChanges(tx, removed.map((key) => ({ kind: "post.unpublished" as const, key })));
    // What's left is NRMS-owned now (the delete above cascaded the rest): stop tracking it.
    const kept = await tx.execute<{ key: string }>(sql`DELETE FROM public_import_posts RETURNING key`);
    return { removed, keptEventOwned: kept.rows.map((r) => r.key).sort() };
  });
}

export interface PublicImportReport {
  mode: "import" | "dry-run" | "remove" | "remove-dry-run";
  fetch?: Omit<FetchedSlice, "records"> & { posts: { key: string; kind: string }[] };
  /** The import's outcome, or (dry run with a database) what it would be. Absent on a dry run without one. */
  write?: PublicImportResult;
  remove?: PublicRemoveResult;
}

/**
 * The whole command, for public-cli.ts (and its tests). `db` may be null only on a dry run:
 * the fetch is then reported without comparing against a database. A dry run never writes.
 */
export async function runPublicImport(
  deps: { db: Db | null; client: PublicApiClient },
  o: PublicImportCliOptions,
  opts: { log?: (msg: string) => void } = {},
): Promise<PublicImportReport> {
  const log = opts.log ?? (() => {});
  if (!deps.db && !o.dryRun) throw new Error("a database is required unless --dry-run");
  if (o.remove) {
    if (!deps.db) throw new Error("--remove needs the database, even with --dry-run");
    return o.dryRun ? { mode: "remove-dry-run", remove: await planPublicRemove(deps.db) } : { mode: "remove", remove: await removePublicPosts(deps.db) };
  }
  const { records, ...rest } = await fetchPublicSlice(deps.client, { perKind: o.perKind, perCategory: o.perCategory, keys: o.keys, maxRequests: o.maxRequests, log });
  const report: PublicImportReport = { mode: o.dryRun ? "dry-run" : "import", fetch: { ...rest, posts: records.map((r) => ({ key: r.key, kind: r.kind })) } };
  log(`[import:public] fetched ${records.length} unique post(s) in ${rest.requests} request(s)`);
  if (deps.db) report.write = o.dryRun ? await planPublicImport(deps.db, records) : await importPublicPosts(deps.db, records, { log });
  return report;
}

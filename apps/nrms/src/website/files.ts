import { randomBytes } from "node:crypto";
import { desc, eq, ilike, sql, type SQL } from "drizzle-orm";
import type { Db, DbOrTx } from "@gcpe/db-kit";
import { assertSafeKey, forceExtension, safeFileName, sniff, type ObjectStore } from "@gcpe/storage";
import { siteFiles } from "../db/schema";
import type { Actor } from "../releases/store";
import { deleteQuietly } from "../storage-log";
import { writeSiteLog } from "./events";
import { SiteConflictError, SiteNotFoundError, SiteRuleError } from "./errors";

/**
 * General files, served publicly at `/files/<name>` (plan 3d task 3). See
 * .superpowers/sdd/2026-10-04-phase-3d-website-section/task-3-brief.md. Files don't emit
 * `site.content.changed` events — they're served directly, not through a snapshot.
 */

export const MAX_SITE_FILE_BYTES = 25 * 1024 * 1024;
const PAGE_SIZE = 50;

export interface SiteFileView {
  id: string;
  name: string;
  url: string;
  contentType: string;
  size: number;
  createdAt: string;
  createdBy: string;
}

type SiteFileRow = typeof siteFiles.$inferSelect;

const fileUrl = (name: string): string => `/files/${name}`;

function view(row: SiteFileRow): SiteFileView {
  return { id: row.id, name: row.name, url: fileUrl(row.name), contentType: row.contentType, size: row.size, createdAt: row.createdAt.toISOString(), createdBy: row.createdBy };
}

export interface ListFilesInput {
  q?: string;
  page?: number;
}

export interface ListFilesResult {
  total: number;
  files: SiteFileView[];
}

/** `q` is a case-insensitive substring of `name`; newest first; 50 per page. */
export async function listFiles(db: DbOrTx, input: ListFilesInput = {}): Promise<ListFilesResult> {
  const page = Math.max(1, input.page ?? 1);
  const where: SQL | undefined = input.q ? ilike(siteFiles.name, `%${input.q}%`) : undefined;
  const [{ n } = { n: 0 }] = await db.select({ n: sql<number>`count(*)::int` }).from(siteFiles).where(where);
  const rows = n === 0 ? [] : await db.select().from(siteFiles).where(where).orderBy(desc(siteFiles.createdAt)).limit(PAGE_SIZE).offset((page - 1) * PAGE_SIZE);
  return { total: n, files: rows.map(view) };
}

/** Magic-byte check, before anything is written — never trusts the declared/claimed type. */
function checkBytes(bytes: Buffer): "application/pdf" | "image/png" | "image/jpeg" {
  if (bytes.length === 0) throw new SiteRuleError(["The file is empty."]);
  const type = sniff(bytes);
  if (!type) throw new SiteRuleError(["Upload a PDF, PNG or JPEG file."]);
  return type;
}

export interface UploadFileInput {
  /** The uploader's original file name. */
  name: string;
  bytes: Buffer;
  replace?: boolean;
}

/**
 * Adds or replaces a general file. The public name is `safeFileName(name)` with its extension
 * forced to match the sniffed type — a single path segment, so it passes `assertSafeKey` and
 * can't collide with `releases/…` (that always has a "/"). The storage key is the name itself.
 *
 * Unlike release files (media/files.ts), this name is fixed and predictable rather than
 * random, so a new upload and a replace can both land on bytes that already exist at `name`.
 * The incoming bytes are always staged under a *temporary* key first (this store has no
 * rename/move, so "moving" bytes onto the real key is a second `put`); the temporary key is
 * always removed afterwards regardless of outcome.
 *
 * Fix round 2: every write (or delete, see {@link deleteFile}) of the *real* key now happens
 * **inside** the database transaction, while that row's lock is held — not after it commits.
 * That's what actually serialises concurrent writers of the same name; a post-commit "move the
 * bytes, then re-check" (fix round 1's approach) left a real gap where a concurrent replace or
 * delete could legitimately change the row in between, and the re-check couldn't tell "my
 * write was orphaned by a delete" apart from "someone else legitimately replaced this file
 * after me" — in the latter case it deleted *their* committed bytes, which is worse than the
 * bug it was meant to fix.
 *
 * - New upload: `INSERT … ON CONFLICT (name) DO NOTHING RETURNING …`. A colliding insert
 *   affects zero rows instead of raising, and an empty `returning()` *is* the conflict
 *   (`SiteConflictError`) — `SELECT … FOR UPDATE WHERE name = X` can't do this job because
 *   with no row yet it has nothing to lock, so two concurrent new uploads of the same name
 *   would both see "no existing row" and both reach the `INSERT`, the loser hitting the raw
 *   unique constraint. Once our insert succeeds, Postgres holds that row — including against
 *   another session's conflicting insert of the same name, which blocks until we commit or
 *   roll back — so it's safe to write the real key next, inside the same transaction, before
 *   anyone else can observe or touch this name.
 * - Replace: `SELECT … FOR UPDATE` genuinely locks the existing row, so a concurrent replace
 *   or delete of the same file blocks until this transaction ends; the real key is written
 *   right after the row update, still inside the lock.
 * - If anything after a *new upload's* real-key write fails — later statements, or the commit
 *   itself — the insert never lands, so there is no row at all; the bytes just written are
 *   therefore fully orphaned and are deleted again. Accepted residual (ruling): for a
 *   *replace*, no such cleanup is attempted if the commit fails after the write — the row
 *   still holds the old committed metadata while the real key may now hold the new bytes, a
 *   rare inconsistency this doesn't try to repair (restoring the old bytes isn't necessarily
 *   even correct — see the report for a fuller discussion).
 */
export async function uploadFile(db: Db, store: ObjectStore, input: UploadFileInput, actor: Actor): Promise<SiteFileView> {
  const contentType = checkBytes(input.bytes);
  const name = forceExtension(safeFileName(input.name), contentType);
  assertSafeKey(name);

  // A prefix (not a suffix) so a long `name` can be truncated to stay inside assertSafeKey's
  // 128-char segment limit without touching the random part that keeps it unique.
  const tempKey = `tmp-${randomBytes(8).toString("hex")}-${name}`.slice(0, 128);
  await store.put(tempKey, input.bytes, contentType);

  // Only true once the real key has actually been written for a brand-new row — see the
  // catch below: that's the one case where a later failure means the bytes are orphaned
  // (no row ever existed) and must be cleaned up; a conflict (thrown before this point) must
  // never touch `name`'s existing bytes, and a replace's accepted residual is never cleaned up.
  let wroteRealKeyForNewRow = false;
  try {
    const row = await db.transaction(async (tx) => {
      if (!input.replace) {
        const [created] = await tx
          .insert(siteFiles)
          .values({ storageKey: name, name, contentType, size: input.bytes.length, createdBy: actor.id })
          .onConflictDoNothing({ target: siteFiles.name })
          .returning();
        if (!created) throw new SiteConflictError("A file with that name already exists.");
        await store.put(name, input.bytes, contentType);
        wroteRealKeyForNewRow = true;
        await writeSiteLog(tx, actor, "files", `Uploaded ${name}`);
        return created;
      }
      const [existing] = await tx.select().from(siteFiles).where(eq(siteFiles.name, name)).for("update");
      if (!existing) throw new SiteNotFoundError(`no file named ${name}`);
      const [updated] = await tx.update(siteFiles).set({ contentType, size: input.bytes.length }).where(eq(siteFiles.id, existing.id)).returning();
      await store.put(name, input.bytes, contentType);
      await writeSiteLog(tx, actor, "files", `Replaced ${name}`);
      return updated!;
    });
    return view(row);
  } catch (e) {
    if (wroteRealKeyForNewRow) await deleteQuietly(store, name, "stored site file", "upload not saved");
    throw e;
  } finally {
    await deleteQuietly(store, tempKey, "stored site file", "upload cleanup");
  }
}

/**
 * Deletes a file: `SELECT … FOR UPDATE` locks the row, then the row and the real key's bytes
 * are both removed before the transaction commits (fix round 2 — see {@link uploadFile}'s
 * doc comment). Locking the row first means a concurrent replace or another delete of the
 * same file blocks until this transaction ends, rather than racing it. Deleting the bytes
 * inside the transaction, not best-effort afterwards, means a failure to delete them aborts
 * the whole delete (row and bytes stay in sync) instead of leaving a row-less orphan.
 */
export async function deleteFile(db: Db, store: ObjectStore, id: string, actor: Actor): Promise<void> {
  await db.transaction(async (tx) => {
    const [row] = await tx.select().from(siteFiles).where(eq(siteFiles.id, id)).for("update");
    if (!row) throw new SiteNotFoundError("file not found");
    await tx.delete(siteFiles).where(eq(siteFiles.id, id));
    await store.delete(row.storageKey);
    await writeSiteLog(tx, actor, "files", `Deleted ${row.name}`);
  });
}

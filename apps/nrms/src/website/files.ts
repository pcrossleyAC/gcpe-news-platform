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
 * To keep that safe under a failed or conflicting save, the new bytes are always written under
 * a *temporary* key first; only after the database transaction (the existence/conflict check,
 * and the insert or update) has committed are they written again under the real key — this
 * store has no rename/move, so "moving" is a second `put` — and the temporary key is removed.
 * A failure or conflict before that point never touches `name`'s existing bytes (or writes any
 * for a brand-new name).
 *
 * A new upload can't rely on `SELECT … FOR UPDATE WHERE name = X` to catch a concurrent upload
 * of the *same new* name: with no row yet, `FOR UPDATE` has nothing to lock, so two concurrent
 * callers would both see "no existing row" and both reach the `INSERT`, and the loser would
 * hit the database's unique constraint directly — a raw driver error (500), not a
 * `SiteConflictError` (409). Instead, the insert itself is the conflict check:
 * `.onConflictDoNothing({ target: siteFiles.name })` makes a colliding insert affect zero
 * rows instead of raising, and an empty `returning()` *is* the conflict. Replacing an existing
 * file has no such gap — the row already exists, so `SELECT … FOR UPDATE` genuinely locks it
 * and serialises concurrent replaces/deletes of it.
 *
 * A second race lives between the transaction committing and the post-commit `put` onto the
 * real key: a concurrent `deleteFile` could remove the row (and delete the real key's bytes,
 * if any) in that gap, after which this `put` would still land, leaving bytes at a public key
 * with no row — served forever, invisible in the list. So after that `put`, the row is
 * re-read by id; if it (or this write — compared by `size`, kept simple per the brief) is
 * gone, the bytes just written are deleted again.
 */
export async function uploadFile(db: Db, store: ObjectStore, input: UploadFileInput, actor: Actor): Promise<SiteFileView> {
  const contentType = checkBytes(input.bytes);
  const name = forceExtension(safeFileName(input.name), contentType);
  assertSafeKey(name);

  // A prefix (not a suffix) so a long `name` can be truncated to stay inside assertSafeKey's
  // 128-char segment limit without touching the random part that keeps it unique.
  const tempKey = `tmp-${randomBytes(8).toString("hex")}-${name}`.slice(0, 128);
  await store.put(tempKey, input.bytes, contentType);
  try {
    const row = await db.transaction(async (tx) => {
      if (!input.replace) {
        const [created] = await tx
          .insert(siteFiles)
          .values({ storageKey: name, name, contentType, size: input.bytes.length, createdBy: actor.id })
          .onConflictDoNothing({ target: siteFiles.name })
          .returning();
        if (!created) throw new SiteConflictError("A file with that name already exists.");
        await writeSiteLog(tx, actor, "files", `Uploaded ${name}`);
        return created;
      }
      const [existing] = await tx.select().from(siteFiles).where(eq(siteFiles.name, name)).for("update");
      if (!existing) throw new SiteNotFoundError(`no file named ${name}`);
      const [updated] = await tx.update(siteFiles).set({ contentType, size: input.bytes.length }).where(eq(siteFiles.id, existing.id)).returning();
      await writeSiteLog(tx, actor, "files", `Replaced ${name}`);
      return updated!;
    });
    // The row is committed; move the bytes onto the real key.
    await store.put(name, input.bytes, contentType);
    // A concurrent delete (or another replace) could have landed in the gap between the
    // commit above and this put — if the row this write committed is gone (or no longer
    // reflects this write), the bytes just written are orphaned; remove them again.
    const [after] = await db.select({ id: siteFiles.id, size: siteFiles.size }).from(siteFiles).where(eq(siteFiles.id, row.id));
    if (!after || after.size !== row.size) {
      await deleteQuietly(store, name, "stored site file", "file removed or replaced during upload");
    }
    return view(row);
  } finally {
    await deleteQuietly(store, tempKey, "stored site file", "upload cleanup");
  }
}

/** Deletes the row, then the bytes once that's committed. */
export async function deleteFile(db: Db, store: ObjectStore, id: string, actor: Actor): Promise<void> {
  let key: string | null = null;
  await db.transaction(async (tx) => {
    const [row] = await tx.delete(siteFiles).where(eq(siteFiles.id, id)).returning();
    if (!row) throw new SiteNotFoundError("file not found");
    key = row.storageKey;
    await writeSiteLog(tx, actor, "files", `Deleted ${row.name}`);
  });
  if (key) await deleteQuietly(store, key, "stored site file", "file deleted");
}

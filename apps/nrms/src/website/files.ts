import { randomBytes } from "node:crypto";
import { desc, eq, ilike, sql, type SQL } from "drizzle-orm";
import type { Db, DbOrTx } from "@gcpe/db-kit";
import { assertSafeKey, forceExtension, safeFileName, sniff, type ObjectStore } from "@gcpe/storage";
import { siteFiles } from "../db/schema";
import type { Actor } from "../releases/store";
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

async function deleteQuietly(store: ObjectStore, key: string, why: string): Promise<void> {
  try {
    await store.delete(key);
  } catch (e) {
    console.error(`[nrms] could not delete stored site file ${key} (${why}): ${e instanceof Error ? e.message : String(e)}`);
  }
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
 * for a brand-new name), and two concurrent uploads of the same new name serialize on the
 * transaction's `FOR UPDATE`: the loser's own temporary key is cleaned up, never the winner's.
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
      const [existing] = await tx.select().from(siteFiles).where(eq(siteFiles.name, name)).for("update");
      if (!input.replace) {
        if (existing) throw new SiteConflictError("A file with that name already exists.");
        const [created] = await tx.insert(siteFiles).values({ storageKey: name, name, contentType, size: input.bytes.length, createdBy: actor.id }).returning();
        await writeSiteLog(tx, actor, "files", `Uploaded ${name}`);
        return created!;
      }
      if (!existing) throw new SiteNotFoundError(`no file named ${name}`);
      const [updated] = await tx.update(siteFiles).set({ contentType, size: input.bytes.length }).where(eq(siteFiles.id, existing.id)).returning();
      await writeSiteLog(tx, actor, "files", `Replaced ${name}`);
      return updated!;
    });
    // The row is committed; move the bytes onto the real key.
    await store.put(name, input.bytes, contentType);
    return view(row);
  } finally {
    await deleteQuietly(store, tempKey, "upload cleanup");
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
  if (key) await deleteQuietly(store, key, "file deleted");
}

import { randomBytes } from "node:crypto";
import { desc, eq, ilike, sql, type SQL } from "drizzle-orm";
import type { Db, DbOrTx } from "@gcpe/db-kit";
import { Readable } from "node:stream";
import { assertSafeKey, ATTACHMENT_TYPES, extensionOf, forceExtension, safeFileName, sniff, type ObjectStore, type SniffedType } from "@gcpe/storage";
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

/**
 * The largest site file (owner decision 2026-10-29: any type, like legacy, whose upload had no
 * practical cap). 512 MiB, the legacy copy tool's default cap. Uploads are streamed to the store,
 * never held in memory; IIS (Install-Gcpe.ps1) and the SiteGround proxy must let this through.
 */
export const MAX_SITE_FILE_BYTES = 512 * 1024 * 1024;
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

const fileUrl = (name: string): string => `/files/${encodeURIComponent(name)}`;

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

const SNIFFABLE_EXTENSIONS = new Set(["pdf", "png", "jpg", "jpeg"]);

/**
 * The type a site file is recorded as: the sniffed type for a PDF, PNG or JPEG; else the type its
 * extension names in the attachment list (Office documents, GIF, RTF, text, CSV); else
 * `application/octet-stream`. Never HTML, SVG or script. A name claiming PDF/PNG/JPEG over bytes
 * that aren't one is octet-stream. (The stack serves `/files` by its own allowlist, files-policy.ts.)
 */
function recordedType(name: string, sniffed: SniffedType | null): string {
  if (sniffed) return sniffed;
  const ext = extensionOf(name);
  if (!ext || SNIFFABLE_EXTENSIONS.has(ext) || !Object.hasOwn(ATTACHMENT_TYPES, ext)) return "application/octet-stream";
  return ATTACHMENT_TYPES[ext as keyof typeof ATTACHMENT_TYPES].contentType;
}

export interface UploadFileInput {
  /** The uploader's original file name. */
  name: string;
  /** The bytes, or `source` to stream them (the HTTP route streams the request body). */
  bytes?: Buffer;
  source?: AsyncIterable<Uint8Array> | Readable;
  replace?: boolean;
  /** Default MAX_SITE_FILE_BYTES. */
  maxBytes?: number;
}

/**
 * Adds or replaces a general file, of any type (owner decision 2026-10-29, like legacy) up to
 * MAX_SITE_FILE_BYTES. The public name is `safeFileName(name)`, with its extension forced to match
 * the sniffed type for a PDF, PNG or JPEG — a single path segment, so it passes `assertSafeKey`
 * and can't collide with `releases/…` (that always has a "/"). The storage key is the name itself
 * (a replace keeps the existing file's name and key). The recorded type is never HTML, SVG or
 * script ({@link recordedType}); the stack serves `/files` by its own allowlist.
 *
 * Unlike release files (media/files.ts), this name is fixed and predictable rather than
 * random, so a new upload and a replace can both land on bytes that already exist at `name`.
 * The incoming bytes are always streamed to a *temporary* key first (never held in memory), then
 * moved (renamed) onto the real key; the temporary key is always removed afterwards regardless
 * of outcome.
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
  // Staged under a temporary key first, streamed (never the whole body in memory), then sniffed
  // from its first bytes and moved onto the real key inside the transaction. A prefix (not a
  // suffix) so a long name can be truncated to stay inside assertSafeKey's 128-char segment limit
  // without touching the random part that keeps it unique.
  const tempKey = `tmp-${randomBytes(8).toString("hex")}-${safeFileName(input.name)}`.slice(0, 128);
  const source = input.source ?? Readable.from(input.bytes ? [input.bytes] : []);

  // Only true once the real key has actually been written for a brand-new row — see the
  // catch below: that's the one case where a later failure means the bytes are orphaned
  // (no row ever existed) and must be cleaned up; a conflict (thrown before this point) must
  // never touch `name`'s existing bytes, and a replace's accepted residual is never cleaned up.
  let wroteRealKeyForNewRow = false;
  let name = "";
  try {
    const staged = await store.putStream(tempKey, source, "application/octet-stream", { maxBytes: input.maxBytes ?? MAX_SITE_FILE_BYTES });
    if (staged.size === 0) throw new SiteRuleError(["The file is empty."]);
    const sniffed = sniff((await store.readHead(tempKey, 1024)) ?? Buffer.alloc(0));
    // A PDF, PNG or JPEG gets the extension its bytes prove (as before); any other type keeps its own.
    name = sniffed ? forceExtension(safeFileName(input.name), sniffed) : safeFileName(input.name);
    assertSafeKey(name);
    const contentType = recordedType(name, sniffed);
    const size = staged.size;

    const row = await db.transaction(async (tx) => {
      // The per-name locks importSiteFile takes (its name is the original spelling), for both spellings
      // this upload could match, in a fixed order, so an upload and a legacy import of one file serialise.
      // A name with control characters (Postgres refuses a NUL in text) can't be any file's name: match on the slug alone.
      const original = /[\u0000-\u001f\u007f]/.test(input.name) ? name : input.name;
      for (const n of [...new Set([original.toLowerCase(), name])].sort()) await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${"site_files:"} || ${n}))`);
      const existing = await sameFile(tx, original, name);
      if (!input.replace) {
        if (existing) throw new SiteConflictError("A file with that name already exists.");
        const [created] = await tx.insert(siteFiles).values({ storageKey: name, name, contentType, size, createdBy: actor.id }).onConflictDoNothing().returning();
        if (!created) throw new SiteConflictError("A file with that name already exists.");
        await store.move(tempKey, name);
        wroteRealKeyForNewRow = true;
        await writeSiteLog(tx, actor, "files", `Uploaded ${name}`);
        return created;
      }
      if (!existing) throw new SiteNotFoundError(`no file named ${name}`);
      // The existing file keeps its name, URL and storage key (an imported legacy file's links keep working).
      const [locked] = await tx.select().from(siteFiles).where(eq(siteFiles.id, existing.id)).for("update");
      if (!locked) throw new SiteNotFoundError(`no file named ${name}`);
      const [updated] = await tx.update(siteFiles).set({ contentType: recordedType(locked.name, sniffed), size }).where(eq(siteFiles.id, locked.id)).returning();
      await store.move(tempKey, locked.storageKey);
      await writeSiteLog(tx, actor, "files", `Replaced ${locked.name}`);
      return updated!;
    });
    return view(row);
  } catch (e) {
    if (wroteRealKeyForNewRow) await deleteQuietly(store, name, "stored site file", "upload not saved");
    // A concurrent writer took the name or the storage key between the check and the insert.
    if (isUniqueViolation(e)) throw new SiteConflictError("A file with that name already exists.");
    throw e;
  } finally {
    await deleteQuietly(store, tempKey, "stored site file", "upload cleanup");
  }
}

function isUniqueViolation(e: unknown): boolean {
  for (let c: unknown = e; c && typeof c === "object"; c = (c as { cause?: unknown }).cause) {
    if ((c as { code?: unknown }).code === "23505") return true;
  }
  return false;
}

/**
 * The existing file an upload of `original` (slugged to `slug`) is the same file as: one named
 * `original` in any letter case with the same extension as the upload's name (an imported legacy
 * file such as `Fact Sheet.pdf` or `Plan Summary.docx`), else one named `slug`, else one stored at
 * `slug` (an imported file whose storage key is the slug). Null when there is none.
 */
async function sameFile(tx: DbOrTx, original: string, slug: string): Promise<SiteFileRow | null> {
  const rows = await tx
    .select()
    .from(siteFiles)
    .where(sql`lower(${siteFiles.name}) = lower(${original}) OR ${siteFiles.name} = ${slug} OR ${siteFiles.storageKey} = ${slug}`);
  return (
    rows.find((r) => r.name.toLowerCase() === original.toLowerCase() && extensionOf(r.name) === extensionOf(slug)) ??
    rows.find((r) => r.name === slug) ??
    rows.find((r) => r.storageKey === slug) ??
    null
  );
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

// ---------------------------------------------------------------- legacy import

/**
 * A legacy file name the public site can serve as `/files/<name>`: one path segment, nothing a
 * file system or URL would read as structure (`/`, `\`, `:`, `~` 8.3 aliases, control
 * characters, Windows-invalid characters or device names, a leading dot, a trailing dot or
 * space), at most 255 characters.
 */
function assertLegacyName(name: string): void {
  const bad =
    name === "" ||
    name.length > 255 ||
    name.startsWith(".") ||
    /[\/\\:~<>"|?*\u0000-\u001f\u007f]/.test(name) ||
    /[. ]$/.test(name) ||
    /^(con|prn|aux|nul|com[0-9\u00b9\u00b2\u00b3]|lpt[0-9\u00b9\u00b2\u00b3]|conin\$|conout\$)(\..*)?$/i.test(name);
  if (bad) throw new SiteRuleError([`"${name.slice(0, 80)}" can't be a file name at /files/.`]);
}

export interface ImportSiteFileInput {
  /** The legacy name (blob metadata `filename`, else the blob name), case kept: the public URL is `/files/<name>`. */
  name: string;
  bytes: Buffer;
  /** As the stack will serve it (apps/stack/src/files-policy.ts). */
  contentType: string;
  /** The legacy blob's Last-Modified. */
  createdAt: Date;
  /** Replace the bytes of an existing file of that name (any case). */
  replace: boolean;
}

export type ImportSiteFileOutcome = "imported" | "replaced" | "exists";

/**
 * Imports one legacy news.gov.bc.ca `/files` file (the legacy Hub's Website > Files uploads) as
 * a site file, so it is listed in the Hub, served at `/files/<name>` and can be deleted or
 * replaced like any upload. Unlike {@link uploadFile}: any type (legacy accepted any; the stack
 * serves anything but inert types as a download), no 25 MB cap (the copy command has its own),
 * the legacy name kept as it is (case and spaces included).
 *
 * Idempotent by name, case-insensitively (legacy resolved `/files/<name>` in any case): an
 * existing file, a staff upload included, is left alone (`exists`) unless `replace`. The
 * storage key is the lowercased name when that is a safe key and free, else
 * `legacy-<8 hex>-<safeFileName(name)>`: always one segment, never `releases/…` or `slides/…`.
 * Bytes are written inside the transaction, under a per-name lock, as uploadFile does.
 */
export async function importSiteFile(db: Db, store: ObjectStore, input: ImportSiteFileInput, actor: Actor): Promise<{ outcome: ImportSiteFileOutcome; view: SiteFileView | null }> {
  assertLegacyName(input.name);
  let wroteNewKey: string | null = null;
  try {
    return await db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${"site_files:"} || lower(${input.name})))`);
      const [existing] = await tx.select().from(siteFiles).where(sql`lower(${siteFiles.name}) = lower(${input.name})`).for("update");
      if (existing && !input.replace) return { outcome: "exists" as const, view: view(existing) };
      if (existing) {
        const [updated] = await tx.update(siteFiles).set({ contentType: input.contentType, size: input.bytes.length }).where(eq(siteFiles.id, existing.id)).returning();
        await store.put(existing.storageKey, input.bytes, input.contentType);
        await writeSiteLog(tx, actor, "files", `Replaced ${existing.name} from legacy`);
        return { outcome: "replaced" as const, view: view(updated!) };
      }
      let storageKey = input.name.toLowerCase();
      let safe = true;
      try {
        assertSafeKey(storageKey);
      } catch {
        safe = false;
      }
      const [taken] = safe ? await tx.select({ id: siteFiles.id }).from(siteFiles).where(eq(siteFiles.storageKey, storageKey)) : [];
      if (!safe || taken || (await store.get(storageKey).catch(() => null))) storageKey = `legacy-${randomBytes(4).toString("hex")}-${safeFileName(input.name)}`.slice(0, 128);
      assertSafeKey(storageKey);
      const [created] = await tx
        .insert(siteFiles)
        .values({ storageKey, name: input.name, contentType: input.contentType, size: input.bytes.length, createdAt: input.createdAt, createdBy: actor.id })
        .onConflictDoNothing()
        .returning();
      if (!created) return { outcome: "exists" as const, view: null };
      await store.put(storageKey, input.bytes, input.contentType);
      wroteNewKey = storageKey;
      await writeSiteLog(tx, actor, "files", `Imported ${input.name} from legacy`);
      return { outcome: "imported" as const, view: view(created) };
    });
  } catch (e) {
    if (wroteNewKey) await deleteQuietly(store, wroteNewKey, "stored site file", "legacy import not saved");
    throw e;
  }
}

/**
 * The site file `/files/<name>` names, case-insensitively (legacy parity: news.gov resolved its
 * files in any letter case); the exact spelling first when several differ only in case. Null
 * when there is none. One indexed-by-scan lookup over a table of at most a few thousand rows.
 */
export async function findSiteFileByName(db: DbOrTx, name: string): Promise<{ name: string; storageKey: string; contentType: string } | null> {
  if (!name) return null;
  const [row] = await db
    .select({ name: siteFiles.name, storageKey: siteFiles.storageKey, contentType: siteFiles.contentType })
    .from(siteFiles)
    .where(sql`lower(${siteFiles.name}) = lower(${name})`)
    .orderBy(sql`${siteFiles.name} = ${name} DESC`, sql`${siteFiles.name} = lower(${name}) DESC`, desc(siteFiles.createdAt))
    .limit(1);
  return row ?? null;
}

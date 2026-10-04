import { and, eq, sql } from "drizzle-orm";
import type { Db, Tx } from "@gcpe/db-kit";
import { typeRules, TYPE_LABEL, type ReleaseView } from "@gcpe/nrms-contract";
import { randomFileKey, sniff, type ObjectStore } from "@gcpe/storage";
import { newsReleases, releaseFiles } from "../db/schema";
import { ReleaseNotFoundError, ReleaseRuleError } from "../releases/errors";
import { mutateRelease, type Actor } from "../releases/store";

export type ReleaseFileKind = "translation" | "asset";

export interface AddReleaseFileInput {
  version: number;
  kind: ReleaseFileKind;
  /** The uploader's original file name — display label and the readable tail of the key only. */
  fileName: string;
  bytes: Buffer;
}

/** Release files (translations and media assets) — 25 MiB per upload (constraints.md). */
export const MAX_RELEASE_FILE_BYTES = 25 * 1024 * 1024;
const MAX_LABEL = 200;

const EXTENSIONS: Record<string, string[]> = {
  "application/pdf": [".pdf"],
  "image/png": [".png"],
  "image/jpeg": [".jpg", ".jpeg"],
};

const LOG_NOUN: Record<ReleaseFileKind, string> = { translation: "translation", asset: "media file" };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Display label: the original name minus control characters (no CR/LF reaches a log or header), ≤ 200 chars. */
export function fileLabel(fileName: string): string {
  // eslint-disable-next-line no-control-regex
  const cleaned = fileName.replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, MAX_LABEL).trim();
  return cleaned || "file";
}

/**
 * The name the storage key is built from. The public `/files` mount derives Content-Type from the
 * key's extension, so the extension must agree with the sniffed bytes: a PNG uploaded as
 * `evil.html` is stored as `…-evil.html.png` and can never be served as HTML.
 */
function keyName(fileName: string, contentType: string): string {
  const lower = fileName.toLowerCase();
  const exts = EXTENSIONS[contentType]!;
  return exts.some((e) => lower.endsWith(e)) ? fileName : `${fileName}${exts[0]}`;
}

/** Magic-byte check, before anything is written. */
function checkBytes(kind: ReleaseFileKind, bytes: Buffer): string {
  if (bytes.length === 0) throw new ReleaseRuleError(["The file is empty."]);
  const type = sniff(bytes);
  if (kind === "translation") {
    if (type !== "application/pdf") throw new ReleaseRuleError(["This file isn't a PDF."]);
    return type;
  }
  if (!type) throw new ReleaseRuleError(["Upload a PDF, PNG or JPEG file."]);
  return type;
}

async function syncFlag(tx: Tx, releaseId: string, kind: ReleaseFileKind): Promise<void> {
  const any = sql<boolean>`EXISTS (SELECT 1 FROM ${releaseFiles} WHERE ${releaseFiles.releaseId} = ${releaseId} AND ${releaseFiles.kind} = ${kind})`;
  await tx.update(newsReleases).set(kind === "translation" ? { hasTranslations: any } : { hasMediaAssets: any }).where(eq(newsReleases.id, releaseId));
}

async function deleteQuietly(store: ObjectStore, key: string, why: string): Promise<void> {
  try {
    await store.delete(key);
  } catch (e) {
    console.error(`[nrms] could not delete stored file ${key} (${why}): ${e instanceof Error ? e.message : String(e)}`);
  }
}

/**
 * Adds a translation PDF or a media asset file. The bytes are written to the store *before* the
 * database transaction (so a committed row always points at a stored file) and deleted again if
 * the transaction fails — a stale version, a refused release type, a deleted release.
 */
export async function addReleaseFile(db: Db, store: ObjectStore, id: string, input: AddReleaseFileInput, actor: Actor): Promise<ReleaseView> {
  const contentType = checkBytes(input.kind, input.bytes);
  const label = fileLabel(input.fileName);
  const key = randomFileKey(`releases/${id}/${input.kind}s`, keyName(label, contentType));
  await store.put(key, input.bytes, contentType);
  try {
    return await mutateRelease(db, id, input.version, actor, async (tx, row) => {
      // Same rule as spec §4 (no categories beyond ministries ⇒ no translations or media files).
      if (!typeRules(row.type).categoriesBeyondMinistries) {
        throw new ReleaseRuleError([`An ${TYPE_LABEL[row.type]} has no translations or media files.`]);
      }
      await tx.insert(releaseFiles).values({ releaseId: row.id, kind: input.kind, storageKey: key, label, contentType, size: input.bytes.length });
      await syncFlag(tx, row.id, input.kind);
      return `Added ${LOG_NOUN[input.kind]} ${label}`;
    });
  } catch (e) {
    await deleteQuietly(store, key, "upload not saved");
    throw e;
  }
}

/** Removes one file; its bytes are deleted from the store once the change has committed. */
export async function removeReleaseFile(db: Db, store: ObjectStore, id: string, fileId: string, version: number, actor: Actor): Promise<ReleaseView> {
  if (!UUID.test(fileId)) throw new ReleaseNotFoundError(fileId);
  let removedKey: string | null = null;
  const view = await mutateRelease(db, id, version, actor, async (tx, row) => {
    const [file] = await tx
      .delete(releaseFiles)
      .where(and(eq(releaseFiles.id, fileId), eq(releaseFiles.releaseId, row.id)))
      .returning();
    if (!file) throw new ReleaseNotFoundError(fileId);
    await syncFlag(tx, row.id, file.kind);
    removedKey = file.storageKey;
    return `Removed ${LOG_NOUN[file.kind]} ${file.label}`;
  });
  if (removedKey) await deleteQuietly(store, removedKey, "file removed");
  return view;
}

/** Best-effort removal of a hard-deleted release's stored files (its rows are already gone). */
export async function deleteStoredFiles(store: ObjectStore, keys: string[]): Promise<void> {
  for (const key of keys) await deleteQuietly(store, key, "release deleted");
}

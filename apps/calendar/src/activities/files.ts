import { createHash } from "node:crypto";
import { and, asc, count, eq, sql } from "drizzle-orm";
import type { DbOrTx, Tx } from "@gcpe/db-kit";
import { ATTACHMENT_MAX_BYTES, ATTACHMENT_MAX_FILES, type ActivityFileView } from "@gcpe/calendar-contract";
import { safeErrorLabel } from "@gcpe/http-kit";
import { checkAttachment, extensionOf, randomFileKey, type AttachmentProblem, type ObjectStore } from "@gcpe/storage";
import type { CalendarActor } from "../actor";
import { can } from "../capabilities";
import { assertNotFrozen } from "../freeze";
import type { ApiDeps } from "../http/routes";
import { dbNow } from "../time";
import { visible } from "../visibility";
import { activityFiles, users } from "../db/schema";
import { ActivityDeletedError, ActivityForbiddenError, ActivityNotFoundError, ActivityValidationError } from "./errors";
import { writeChange } from "./history";
import { assertNotLockedByOther } from "./locks";
import { factsOf, loadStored, lockActivity, type StoredActivity } from "./store";

/** The activity's files, by name as people read it. Callers check visibility first. */
export async function filesOf(db: DbOrTx, activityId: number): Promise<ActivityFileView[]> {
  const rows = await db
    .select({
      id: activityFiles.id, fileName: activityFiles.fileName, contentType: activityFiles.contentType, length: activityFiles.length,
      uploadedAt: activityFiles.uploadedAt, uploadedByName: users.displayName,
    })
    .from(activityFiles)
    .leftJoin(users, eq(users.id, activityFiles.uploadedBy))
    .where(eq(activityFiles.activityId, activityId))
    .orderBy(asc(sql`lower(${activityFiles.fileName})`), asc(activityFiles.id));
  return rows.map((r) => ({ ...r, uploadedAt: r.uploadedAt.toISOString(), uploadedByName: r.uploadedByName ?? null }));
}

/** A file row whose bytes are gone from the store: a 404, and one log line. */
export class StoredFileMissingError extends Error {
  override name = "StoredFileMissingError";
}

const PROBLEMS: Record<AttachmentProblem, (ext: string | null) => string> = {
  empty: () => "The file is empty.",
  blocked: () => "This type of file can't be attached.",
  unsupported: () => "Attach a PDF, image (PNG, JPEG or GIF), Word, Excel, PowerPoint, Outlook message, RTF, text or CSV file.",
  mismatch: (ext) => `The file's contents aren't a .${ext} file.`,
};
const invalid = (message: string) => new ActivityValidationError([{ field: "files", message }]);

const MAX_NAME = 255;
/**
 * The name people see: the last segment of what the browser sent (legacy's Path.GetFileName, for
 * either slash), control characters as spaces, at most 255 characters keeping the extension.
 */
export function attachmentName(original: string): string {
  const last = original.split(/[\\/]/).pop() ?? "";
  // \p{Cc}: C0/C1 controls. \p{Cf}: format characters, including the bidi overrides (U+202A-U+202E).
  const cleaned = last.replace(/[\p{Cc}\p{Cf}]+/gu, " ").replace(/\s+/g, " ").trim();
  if (cleaned.length <= MAX_NAME) return cleaned;
  const dot = cleaned.lastIndexOf(".");
  const ext = dot > 0 && cleaned.length - dot <= 11 ? cleaned.slice(dot) : "";
  return cleaned.slice(0, MAX_NAME - ext.length) + ext;
}

/** Every file write's checks, in the order a person can act on them (spec addendum §6, §7.4, §7.5). */
async function assertCanChangeFiles(tx: Tx, deps: ApiDeps, actor: CalendarActor, s: StoredActivity | null): Promise<StoredActivity> {
  if (!s || !visible(actor, factsOf(s))) throw new ActivityNotFoundError();
  if (s.row.deletedAt) throw new ActivityDeletedError();
  if (!can.edit(actor, factsOf(s))) throw new ActivityForbiddenError("Only the lead ministry and HQ change this activity's files");
  assertNotFrozen(await dbNow(tx, deps.now), actor, deps.rules);
  await assertNotLockedByOther(tx, deps, actor, s.row.id);
  return s;
}

/** Before the body is read: a caller who couldn't save the file is refused without their bytes being buffered. */
export async function precheckFileWrite(deps: ApiDeps, actor: CalendarActor, id: number): Promise<void> {
  await deps.db.transaction(async (tx) => {
    await assertCanChangeFiles(tx, deps, actor, await loadStored(tx, id));
  });
}

/** On a failed delete, names only the activity id and the file row id — never the file name or storage key. */
async function deleteQuietly(store: ObjectStore, key: string, orphan?: { activityId: number; fileId: number }): Promise<void> {
  try {
    await store.delete(key);
  } catch (e) {
    if (orphan) console.error("[calendar] could not delete a stored file", orphan.activityId, orphan.fileId, safeErrorLabel(e));
    else console.error("[calendar] could not delete a stored file", safeErrorLabel(e));
  }
}

/**
 * Adds a file, or replaces the one with the same name in any case (Activity.aspx.cs:1436-1437).
 * The bytes are stored first, so a committed row always has them, and deleted again if the
 * transaction fails. History records it; the version, "last updated" and needs-review don't change.
 */
export async function addFile(deps: ApiDeps, store: ObjectStore, actor: CalendarActor, id: number, original: string, bytes: Buffer): Promise<ActivityFileView[]> {
  const fileName = attachmentName(original);
  if (fileName === "") throw invalid("Name the file.");
  if (bytes.length > ATTACHMENT_MAX_BYTES) throw invalid("A file can be at most 25 MB.");
  const check = checkAttachment(fileName, bytes);
  if (!check.ok) throw invalid(PROBLEMS[check.problem](extensionOf(fileName)));
  const key = randomFileKey(`activities/${id}`, fileName);
  let replaced: { key: string; fileId: number } | null;
  try {
    await store.put(key, bytes, check.contentType);
    replaced = await deps.db.transaction(async (tx) => {
      await lockActivity(tx, id);
      const s = await assertCanChangeFiles(tx, deps, actor, await loadStored(tx, id, { forUpdate: true }));
      const now = await dbNow(tx, deps.now);
      const [old] = await tx.select().from(activityFiles).where(and(eq(activityFiles.activityId, id), sql`lower(${activityFiles.fileName}) = lower(${fileName})`));
      if (old) {
        await tx.delete(activityFiles).where(eq(activityFiles.id, old.id));
      } else {
        const [{ n }] = (await tx.select({ n: count() }).from(activityFiles).where(eq(activityFiles.activityId, id))) as [{ n: number }];
        if (n >= ATTACHMENT_MAX_FILES) throw invalid(`An activity holds at most ${ATTACHMENT_MAX_FILES} files. Remove one first.`);
      }
      await tx.insert(activityFiles).values({
        activityId: id, fileName, contentType: check.contentType, length: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"), storageKey: key, uploadedAt: now, uploadedBy: actor.userId,
      });
      await writeChange(tx, {
        activityId: id, actor, action: "updated", contactMinistryKey: s.row.contactMinistryKey, at: now,
        fields: [{ key: "files", old: old ? old.fileName : null, new: old ? `${fileName} (replaced)` : fileName }],
      });
      return old ? { key: old.storageKey, fileId: old.id } : null;
    });
  } catch (e) {
    await deleteQuietly(store, key);
    throw e;
  }
  if (replaced) await deleteQuietly(store, replaced.key, { activityId: id, fileId: replaced.fileId });
  return filesOf(deps.db, id);
}

/** Removes one file; its bytes go once the change has committed. */
export async function removeFile(deps: ApiDeps, store: ObjectStore, actor: CalendarActor, id: number, fileId: number): Promise<ActivityFileView[]> {
  const removedKey = await deps.db.transaction(async (tx) => {
    await lockActivity(tx, id);
    const s = await assertCanChangeFiles(tx, deps, actor, await loadStored(tx, id, { forUpdate: true }));
    const [file] = await tx.delete(activityFiles).where(and(eq(activityFiles.id, fileId), eq(activityFiles.activityId, id))).returning();
    if (!file) throw new ActivityNotFoundError();
    await writeChange(tx, {
      activityId: id, actor, action: "updated", contactMinistryKey: s.row.contactMinistryKey, at: await dbNow(tx, deps.now),
      fields: [{ key: "files", old: file.fileName, new: null }],
    });
    return file.storageKey;
  });
  await deleteQuietly(store, removedKey, { activityId: id, fileId });
  return filesOf(deps.db, id);
}

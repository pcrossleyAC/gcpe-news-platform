import { createHash } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "@gcpe/db-kit";
import { wallClockToInstant } from "@gcpe/legacy-import";
import { checkAttachment, randomFileKey, type ObjectStore } from "@gcpe/storage";
import type { LegacyKeys } from "../../../core/src/import/legacy-keys";
import { attachmentName } from "../activities/files";
import { activityChangeFields, activityChanges, activityFiles, favourites, savedFilters, userProfiles } from "../db/schema";
import { legacyDisplay, legacyHiddenColumns, migrateLegacySavedFilters } from "../list/legacy-filters";
import type { HistoryEntry } from "./history-map";
import type { LegacySnapshot } from "./legacy-rows";
import { stripNul } from "./map";
import type { CalendarImportReport } from "./report";
import type { Scope } from "./scope";

/**
 * Reports on every favourite not already handled by `applyActivities`: one on an activity
 * inserted in this same run was already inserted, atomically, with that activity, so it's skipped
 * here without being re-counted. Everything else is reporting only, never an insert: a favourite on
 * an activity that was already present before this run started either still exists (unchanged) or
 * was removed since (by a user, or never there to begin with) and must stay that way.
 */
export async function applyFavourites(db: Db, scope: Scope, userIdOf: (id: number) => string | null, present: Set<number>, inserted: Set<number>, report: CalendarImportReport): Promise<void> {
  for (const f of scope.favourites) {
    if (inserted.has(f.ActivityId)) continue;
    const userId = userIdOf(f.SystemUserId);
    if (!userId) { report.skip("favourites", `${f.SystemUserId}/${f.ActivityId}`, "its user wasn't imported"); continue; }
    if (!present.has(f.ActivityId)) { report.skip("favourites", `${f.SystemUserId}/${f.ActivityId}`, "its activity wasn't imported"); continue; }
    const [has] = await db.select().from(favourites).where(and(eq(favourites.userId, userId), eq(favourites.activityId, f.ActivityId)));
    if (has) report.count("favourites", "unchanged");
    else report.skip("favourites", `${f.SystemUserId}/${f.ActivityId}`, "its activity was already present before this run; favourites are copied only when the activity is inserted");
  }
}

const MOBILE = /^[0-9-]{12}$/;
const cap = (s: string | null, n: number) => (s === null ? null : stripNul(s).trim().slice(0, n) || null);

/** One profile per imported Core user, from the legacy row chosen for that user, written once. */
export async function applyProfiles(db: Db, s: LegacySnapshot, groups: { userId: string; legacyIds: number[]; representativeLegacyId: number }[], report: CalendarImportReport): Promise<void> {
  for (const g of groups) {
    const u = s.users.find((x) => x.Id === g.representativeLegacyId)!;
    const mobileRaw = u.MobileNumber === null ? null : stripNul(u.MobileNumber).trim();
    const mobile = mobileRaw === null || mobileRaw === "" || MOBILE.test(mobileRaw) ? mobileRaw : null;
    if (mobileRaw !== null && mobile === null) report.note(`legacy user ${u.Id}'s mobile number didn't match legacy's own format and was left out`);
    const rows = await db.insert(userProfiles).values({
      userId: g.userId, phone: cap(u.PhoneNumber, 20), mobile, jobTitle: cap(u.JobTitle, 100), description: cap(u.Description, 2000),
      listDisplay: legacyDisplay(u.FilterDisplayValue), hiddenColumns: legacyHiddenColumns(u.HiddenColumns),
    }).onConflictDoNothing().returning({ userId: userProfiles.userId });
    report.count("profiles", rows.length ? "inserted" : "unchanged");
  }
  report.legacy("profiles", groups.length);
}

/** Active legacy saved queries not yet in the Calendar, through the list's converter (5d). */
export async function applySavedFilters(db: Db, scope: Scope, userIdOf: (id: number) => string | null, keys: LegacyKeys, report: CalendarImportReport): Promise<void> {
  const ids = scope.savedFilters.map((f) => f.Id);
  const existing = new Set(ids.length ? (await db.select({ id: savedFilters.id }).from(savedFilters).where(inArray(savedFilters.id, ids))).map((r) => r.id) : []);
  report.count("savedFilters", "unchanged", existing.size);
  const fresh = scope.savedFilters.filter((f) => !existing.has(f.Id));
  if (!fresh.length) return;
  const r = await migrateLegacySavedFilters(db, fresh.map((f) => ({ id: f.Id, createdBy: f.CreatedBy, name: f.Name, queryString: f.QueryString, sortOrder: f.SortOrder, isActive: f.IsActive })), {
    ministryKeyOf: (g) => keys.org(g)?.key ?? null,
    userIdOf: (id) => userIdOf(id),
  });
  report.count("savedFilters", "inserted", r.migrated);
  for (const n of r.skippedNoOwner) report.skip("savedFilters", String(n.id), "no imported owner, or the owner's id couldn't be resolved to a user");
  for (const n of r.skippedInvalid ?? []) report.skip("savedFilters", String(n.id), n.reason);
  report.savedFilterNotes({ strippedPrefix: r.strippedPrefix, dropped: r.dropped.map((d) => ({ id: d.id, key: d.key, reason: d.reason })), overCap: r.overCap ?? [] });
}

/**
 * Attachments of imported activities (spec addendum §12.1 step 6). The MD5 is checked against the
 * bytes; the bytes go into the store first and are removed again if the row can't be written.
 */
export async function applyFiles(db: Db, store: ObjectStore, scope: Scope, userIdOf: (id: number) => string | null, present: Set<number>, timeZone: string, report: CalendarImportReport): Promise<void> {
  for (const f of scope.files) {
    if (!present.has(f.ActivityId)) { report.skip("files", String(f.Id), "its activity wasn't imported"); continue; }
    const [has] = await db.select({ id: activityFiles.id }).from(activityFiles).where(eq(activityFiles.id, f.Id));
    if (has) { report.count("files", "unchanged"); continue; }
    if (createHash("md5").update(f.Data).digest("hex") !== f.Md5.trim().toLowerCase()) { report.skip("files", String(f.Id), "MD5 doesn't match the bytes"); continue; }
    const fileName = attachmentName(f.FileName) || `attachment-${f.Id}`;
    const check = checkAttachment(fileName, f.Data);
    const contentType = check.ok ? check.contentType : (f.FileType.trim().slice(0, 255) || "application/octet-stream");
    const key = randomFileKey(`activities/${f.ActivityId}`, fileName);
    await store.put(key, f.Data, contentType);
    try {
      const rows = await db.insert(activityFiles).values({
        id: f.Id, activityId: f.ActivityId, fileName, contentType, length: f.Data.length,
        sha256: createHash("sha256").update(f.Data).digest("hex"), storageKey: key,
        uploadedAt: wallClockToInstant(f.LastUpdatedDateTime, timeZone), uploadedBy: f.LastUpdatedBy === null ? null : userIdOf(f.LastUpdatedBy),
      }).onConflictDoNothing().returning({ id: activityFiles.id });
      if (rows.length) report.count("files", "inserted");
      else { await store.delete(key); report.skip("files", String(f.Id), "another file on the activity has this name"); }
    } catch (e) {
      await store.delete(key).catch(() => false);
      throw e;
    }
  }
}

/** Legacy log entries of imported activities, once each (activity_changes.legacy_key). Counted per legacy log row. */
export async function applyHistory(db: Db, entries: HistoryEntry[], skipped: { logId: number; reason: string }[], present: Set<number>, report: CalendarImportReport): Promise<void> {
  for (const s of skipped) report.skip("logRows", String(s.logId), s.reason);
  for (const e of entries) {
    if (!present.has(e.activityId)) { for (const id of e.logIds) report.skip("logRows", String(id), "its activity wasn't imported"); continue; }
    const added = await db.transaction(async (tx) => {
      const [row] = await tx.insert(activityChanges).values({
        activityId: e.activityId, at: e.at, actorId: e.actorId, actorName: e.actorName, action: "updated", source: "legacy_log",
        contactMinistryKey: e.contactMinistryKey, legacyKey: e.legacyKey,
      }).onConflictDoNothing({ target: activityChanges.legacyKey }).returning({ id: activityChanges.id });
      if (!row) return false;
      await tx.insert(activityChangeFields).values(e.fields.map((f) => ({ changeId: row.id, fieldKey: f.key, oldValue: f.old, newValue: f.new })));
      return true;
    });
    report.count("logRows", added ? "inserted" : "unchanged", e.logIds.length);
  }
}

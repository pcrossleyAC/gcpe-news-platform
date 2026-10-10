import type { ActivityFields } from "@gcpe/calendar-contract";

/**
 * Session-expiry recovery for the activity editor, after the release editor's
 * unsavedDocumentStorage.ts: when a 401 sends the user to sign in while the form holds unsaved
 * changes, they are kept in `sessionStorage`, keyed by user id and activity, and the same activity
 * opened again by the same user brings them back. The version they were based on comes back with
 * them, so a save over someone else's newer change still meets the server's 409.
 *
 * Cleared on save and on discard. An explicit sign-out clears every one
 * ({@link clearAllActivityDrafts}, from SessionContext's `signOut`): the next person to sign in on
 * this tab may not be the same user.
 */
const PREFIX = "gcpe-calendar-draft";

export interface ActivityDraft {
  activityId: number | "new";
  /** The version the changes were based on; null for a new activity. */
  version: number | null;
  fields: ActivityFields;
}

const storageKey = (userId: string, activityId: number | "new") => `${PREFIX}:${userId}:${activityId}`;

/** Unavailable in some browsers' private modes: every call here degrades to "no draft". */
function storage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

export function saveActivityDraft(userId: string, draft: ActivityDraft): void {
  try {
    storage()?.setItem(storageKey(userId, draft.activityId), JSON.stringify(draft));
  } catch {
    // Best effort: a full or blocked storage loses the recovery, never the session's redirect.
  }
}

export function loadActivityDraft(userId: string, activityId: number | "new"): ActivityDraft | null {
  try {
    const raw = storage()?.getItem(storageKey(userId, activityId));
    if (!raw) return null;
    const d = JSON.parse(raw) as Partial<ActivityDraft>;
    return d.activityId === activityId && d.fields && typeof d.fields === "object" ? (d as ActivityDraft) : null;
  } catch {
    return null;
  }
}

export function clearActivityDraft(userId: string, activityId: number | "new"): void {
  try {
    storage()?.removeItem(storageKey(userId, activityId));
  } catch {
    // Nothing to do: see saveActivityDraft.
  }
}

/** Every kept activity draft in this tab, for every user: called on an explicit sign-out, never on a 401. */
export function clearAllActivityDrafts(): void {
  const s = storage();
  if (!s) return;
  try {
    const keys: string[] = [];
    for (let i = 0; i < s.length; i++) {
      const k = s.key(i);
      if (k?.startsWith(`${PREFIX}:`)) keys.push(k);
    }
    for (const k of keys) s.removeItem(k);
  } catch {
    // Nothing to do: see saveActivityDraft.
  }
}

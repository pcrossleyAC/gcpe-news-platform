/**
 * Session-expiry recovery for a document-language form (task-4-brief.md, Review Focus 1), the
 * same way the Calendar's activity editor does it (screens/calendar/activity/draft.ts): when a
 * 401 is about to send the user to sign in while the form holds unsaved changes, they are kept in
 * `sessionStorage`, keyed by signed-in user id + release id + document id + language, together
 * with the release version they were based on. The same user opening the same release again gets
 * them back, and a save of them goes with that version, so it meets the server's 409 if the
 * release changed since instead of silently overwriting the newer content (suite review R3).
 *
 * Cleared once the form holds it again, on a successful save, on Leave in "Unsaved changes"
 * ({@link clearReleaseDrafts}) and on an explicit sign-out ({@link clearAllDrafts}, from
 * SessionContext's `signOut`: the next person to sign in on this tab may not be the same user).
 * Never written for a read-only (non-Editor) user.
 *
 * Fix round 1, finding 1: the user id is part of the key, so on a shared machine a different user
 * signing in on the same tab never sees the previous user's unsaved text.
 */
const PREFIX = "gcpe-nrms-draft";

export interface DocumentDraftKey {
  userId: string;
  releaseId: string;
  documentId: string;
  languageId: number;
}

function storageKey({ userId, releaseId, documentId, languageId }: DocumentDraftKey): string {
  return `${PREFIX}:${userId}:${releaseId}:${documentId}:${languageId}`;
}

/** `sessionStorage` is unavailable in some environments (private browsing, SSR, a locked-down
 * test runner) — every call here degrades to "no draft" rather than throwing. */
function storage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

/** Unsaved form values and the release version they were based on. */
export interface DocumentDraft<T> {
  version: number;
  form: T;
}

export function saveDraft<T>(key: DocumentDraftKey, draft: DocumentDraft<T>): void {
  try {
    storage()?.setItem(storageKey(key), JSON.stringify(draft));
  } catch {
    // Best-effort — losing the draft-recovery convenience is fine; losing the save isn't, and
    // this never blocks that.
  }
}

/** The kept draft, or null. One kept before drafts carried a version is ignored: with no version
 * it can't be checked against newer content. */
export function loadDraft<T>(key: DocumentDraftKey): DocumentDraft<T> | null {
  try {
    const raw = storage()?.getItem(storageKey(key));
    if (!raw) return null;
    const d = JSON.parse(raw) as Partial<DocumentDraft<T>>;
    return typeof d.version === "number" && d.form !== null && typeof d.form === "object" ? (d as DocumentDraft<T>) : null;
  } catch {
    return null;
  }
}

export function clearDraft(key: DocumentDraftKey): void {
  try {
    storage()?.removeItem(storageKey(key));
  } catch {
    // Nothing to do — see saveDraft.
  }
}

function removeWithPrefix(prefix: string): void {
  const s = storage();
  if (!s) return;
  try {
    const toRemove: string[] = [];
    for (let i = 0; i < s.length; i++) {
      const k = s.key(i);
      if (k?.startsWith(prefix)) toRemove.push(k);
    }
    for (const k of toRemove) s.removeItem(k);
  } catch {
    // Nothing to do — see saveDraft.
  }
}

/** Removes every kept draft of one release for one user: Leave in "Unsaved changes" discards them. */
export function clearReleaseDrafts(userId: string, releaseId: string): void {
  removeWithPrefix(`${PREFIX}:${userId}:${releaseId}:`);
}

/** Removes every document draft in this tab, for every user and release — called on an
 * explicit sign-out (SessionContext's `signOut`), never on a 401 (see the file header). */
export function clearAllDrafts(): void {
  removeWithPrefix(`${PREFIX}:`);
}

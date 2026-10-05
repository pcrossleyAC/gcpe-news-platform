/**
 * Session-expiry recovery for a document-language form (task-4-brief.md, Review Focus 1):
 * unsaved field/body text is kept in `sessionStorage`, keyed by signed-in user id + release id
 * + document id + language, while the form is dirty — so a 401 mid-edit (RequireAuth sends the
 * user to `/hub/sign-in?return=<path>` and back) doesn't lose what they'd typed. Cleared on a
 * successful save, and never written to at all for a read-only (non-Editor) user.
 *
 * Fix round 1, finding 1: the user id is part of the key (not just release/document/language) —
 * on a shared machine, a different user signing in on the same tab must never see the previous
 * user's unsaved text. An *expired* session (a 401) deliberately leaves the draft in place (the
 * same user signing back in gets it back); only an *explicit* sign-out ({@link clearAllDrafts},
 * called from SessionContext's `signOut`) wipes every draft, since at that point there's no way
 * to tell whether the next sign-in on this tab will be the same person.
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

export function saveDraft<T>(key: DocumentDraftKey, data: T): void {
  try {
    storage()?.setItem(storageKey(key), JSON.stringify(data));
  } catch {
    // Best-effort — losing the draft-recovery convenience is fine; losing the save isn't, and
    // this never blocks that.
  }
}

export function loadDraft<T>(key: DocumentDraftKey): T | null {
  try {
    const raw = storage()?.getItem(storageKey(key));
    return raw ? (JSON.parse(raw) as T) : null;
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

/** Removes every document draft in this tab, for every user and release — called on an
 * explicit sign-out (SessionContext's `signOut`), never on a 401 (see the file header). */
export function clearAllDrafts(): void {
  const s = storage();
  if (!s) return;
  try {
    const toRemove: string[] = [];
    for (let i = 0; i < s.length; i++) {
      const k = s.key(i);
      if (k?.startsWith(`${PREFIX}:`)) toRemove.push(k);
    }
    for (const k of toRemove) s.removeItem(k);
  } catch {
    // Nothing to do — see saveDraft.
  }
}

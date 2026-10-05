/**
 * Session-expiry recovery for a document-language form (task-4-brief.md, Review Focus 1):
 * unsaved field/body text is kept in `sessionStorage`, keyed by release id + document id +
 * language, while the form is dirty — so a 401 mid-edit (RequireAuth sends the user to
 * `/hub/sign-in?return=<path>` and back) doesn't lose what they'd typed. Cleared on a
 * successful save, and never written to at all for a read-only (non-Editor) user.
 */
const PREFIX = "gcpe-nrms-draft";

export interface DocumentDraftKey {
  releaseId: string;
  documentId: string;
  languageId: number;
}

function storageKey({ releaseId, documentId, languageId }: DocumentDraftKey): string {
  return `${PREFIX}:${releaseId}:${documentId}:${languageId}`;
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

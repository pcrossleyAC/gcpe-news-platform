import { LANG_EN, type DocumentLanguageView, type DocumentView, type ReleaseLanguageView, type ReleaseView } from "@gcpe/nrms-contract";

/** The release's first document (lowest `sortIndex`) — apps/nrms/src/releases/queries.ts's own
 * "first document's English headline" convention for the list/search display headline. */
export function firstDocument(view: ReleaseView): DocumentView | undefined {
  return [...view.documents].sort((a, b) => a.sortIndex - b.sortIndex)[0];
}

export function englishOf(doc: DocumentView | undefined): DocumentLanguageView | undefined {
  return doc?.languages.find((l) => l.languageId === LANG_EN);
}

/** The headline shown as the editor's `h1` — the first document's English headline, same rule
 * the list/search screens use server-side. */
export function headlineOf(view: ReleaseView): string {
  return englishOf(firstDocument(view))?.headline ?? "";
}

/** The release-level (not document-level) language row — location/summary/social-media summary
 * that `PUT .../meta` edits live here, for English by default. */
export function releaseLanguageOf(view: ReleaseView, languageId: number = LANG_EN): ReleaseLanguageView | undefined {
  return view.languages.find((l) => l.languageId === languageId);
}

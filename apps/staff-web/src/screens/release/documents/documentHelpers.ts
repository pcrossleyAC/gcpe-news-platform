import type { DocumentLanguageView, DocumentView, LanguageId, Layout, ReleaseView } from "@gcpe/nrms-contract";

/** A document layout as the screens name it. */
export const LAYOUT_LABEL: Record<Layout, string> = { formal: "Formal", informal: "Informal" };

export function findDocument(view: ReleaseView, documentId: string): DocumentView | undefined {
  return view.documents.find((d) => d.id === documentId);
}

export function findLanguage(doc: DocumentView | undefined, languageId: LanguageId): DocumentLanguageView | undefined {
  return doc?.languages.find((l) => l.languageId === languageId);
}

/** Documents in display order (lowest `sortIndex` first) — the one place that order is
 * computed, shared by the list, drag-and-drop and the Move up/down buttons. */
export function documentsInOrder(view: ReleaseView): DocumentView[] {
  return [...view.documents].sort((a, b) => a.sortIndex - b.sortIndex);
}

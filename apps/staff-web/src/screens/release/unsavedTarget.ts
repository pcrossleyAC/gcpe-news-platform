import type { ReleaseView } from "@gcpe/nrms-contract";
import { documentsInOrder } from "./documents/documentHelpers";

/** Where a dirty section lives (the "save first" blockers and the save bar link to it) on the page, by its {@link useRegisterDirty} key. */
export function unsavedTarget(key: string, view: ReleaseView): string | null {
  const fixed: Record<string, string> = { settings: "section-settings", "page-details": "section-page-details", categories: "section-categories", asset: "section-asset" };
  if (fixed[key]) return fixed[key];
  // A document language: its own tab panel (DocumentTabs shows that tab when the link is
  // followed — the edited language may not be the one showing).
  const doc = /^document-(.+)-(\d+)$/.exec(key);
  if (doc) return documentsInOrder(view).some((d) => d.id === doc[1]) ? `doc-${doc[1]}-panel-${doc[2]}` : "section-documents";
  return null;
}

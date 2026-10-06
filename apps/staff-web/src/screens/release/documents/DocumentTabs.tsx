import { useState } from "react";
import { AlertDialog, Button, DialogTrigger, InlineAlert, Modal } from "@bcgov/design-system-react-components";
import { LANG_EN, LANG_FR, LANGUAGE_NAME, type LanguageId, type ReleaseView } from "@gcpe/nrms-contract";
import { RELOAD_MESSAGE, useReleaseSection } from "../useReleaseSection";
import { findDocument } from "./documentHelpers";
import { DocumentLanguageForm } from "./DocumentLanguageForm";

export interface DocumentTabsProps {
  view: ReleaseView;
  setView(v: ReleaseView): void;
  documentId: string;
  readOnly: boolean;
}

const BOTH_LANGUAGES: LanguageId[] = [LANG_EN, LANG_FR];

/**
 * One document's English/French tabs (task-4-brief.md), plus adding or removing the French
 * translation (`POST .../documents/:docId/translations` and `.../translations/:lang/remove`).
 * A manual tab list (the design system has no Tabs component) — `role="tablist"`/`"tab"`/
 * `"tabpanel"`, each tab a real `<button>`, keyboard-operable by default.
 */
export function DocumentTabs({ view, setView, documentId, readOnly }: DocumentTabsProps): React.JSX.Element {
  const section = useReleaseSection(view, setView);
  const doc = findDocument(view, documentId);
  const present = BOTH_LANGUAGES.filter((l) => doc?.languages.some((dl) => dl.languageId === l));
  const missing = BOTH_LANGUAGES.filter((l) => !present.includes(l));
  const [active, setActive] = useState<LanguageId>(present[0] ?? LANG_EN);
  const [removeOpen, setRemoveOpen] = useState(false);

  if (!doc) return <p role="alert">This document no longer exists.</p>;
  const activeLanguage = present.includes(active) ? active : present[0]!;
  // apps/nrms/src/releases/service.ts's removeTranslation: removing LANG_EN removes the whole
  // *document* (English is the document's base identity) — that's the separate "Remove
  // document" action (DocumentsSection.tsx), never offered here. Only a non-English language
  // (French) can be removed as "just a translation".
  const removableLanguage = present.find((l) => l !== LANG_EN);

  const addTranslation = (languageId: LanguageId) => {
    void section.save(`/documents/${documentId}/translations`, { version: view.version, languageId }, "POST").then((next) => {
      if (next) setActive(languageId);
    });
  };

  const confirmRemoveTranslation = async () => {
    if (!removableLanguage) return;
    const next = await section.save(`/documents/${documentId}/translations/${removableLanguage}/remove`, { version: view.version }, "POST");
    if (next) {
      setRemoveOpen(false);
      const stillPresent = BOTH_LANGUAGES.filter((l) => findDocument(next, documentId)?.languages.some((dl) => dl.languageId === l));
      setActive(stillPresent[0] ?? LANG_EN);
    }
  };

  return (
    <div className="gcpe-document-tabs">
      {section.conflict && <InlineAlert variant="danger" role="alert" description={RELOAD_MESSAGE} buttons={<Button onPress={() => void section.reload()}>Reload</Button>} />}
      {section.problems && (
        <ul role="alert" className="gcpe-release-editor__problems">
          {section.problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      )}

      {/* A `role="tablist"` may only contain `role="tab"` children (axe: aria-required-children)
       * — the Add/Remove translation actions are a separate, sibling toolbar, not tabs. */}
      <div role="tablist" aria-label="Document language">
        {present.map((l) => (
          <button key={l} type="button" role="tab" aria-selected={l === activeLanguage} id={`doc-${documentId}-tab-${l}`} onClick={() => setActive(l)}>
            {LANGUAGE_NAME[l]}
          </button>
        ))}
      </div>
      <div className="gcpe-document-tabs__translation-actions">
        {!readOnly &&
          missing.map((l) => (
            <Button key={l} variant="secondary" onPress={() => addTranslation(l)} isDisabled={section.saving}>
              Add {LANGUAGE_NAME[l]} translation
            </Button>
          ))}
        {!readOnly && removableLanguage && (
          <DialogTrigger isOpen={removeOpen} onOpenChange={setRemoveOpen}>
            <Button variant="secondary" danger isDisabled={section.saving}>
              Remove {LANGUAGE_NAME[removableLanguage]} translation
            </Button>
            <Modal isDismissable>
              <AlertDialog
                variant="destructive"
                title={`Remove the ${LANGUAGE_NAME[removableLanguage]} translation?`}
                buttons={
                  <>
                    <Button onPress={() => setRemoveOpen(false)}>Cancel</Button>
                    <Button danger onPress={() => void confirmRemoveTranslation()}>
                      Confirm remove
                    </Button>
                  </>
                }
              >
                <p>This deletes the {LANGUAGE_NAME[removableLanguage]} page title, headline and body for this document. It can&rsquo;t be undone.</p>
              </AlertDialog>
            </Modal>
          </DialogTrigger>
        )}
      </div>

      <div role="tabpanel" id={`doc-${documentId}-panel-${activeLanguage}`} aria-labelledby={`doc-${documentId}-tab-${activeLanguage}`}>
        {/* `key` forces a full remount on language switch — DocumentLanguageForm's own form
         * state is seeded once (from the server value or a restored draft) in a `useState`
         * initializer, which otherwise wouldn't re-run on a languageId prop change alone. */}
        <DocumentLanguageForm key={activeLanguage} view={view} setView={setView} documentId={documentId} languageId={activeLanguage} readOnly={readOnly} />
      </div>
    </div>
  );
}

import { useEffect, useState, type FormEvent } from "react";
import { AlertDialog, Button, DialogTrigger, InlineAlert, Modal, TextField } from "@bcgov/design-system-react-components";
import { LANG_EN, LAYOUTS, type Layout, type ReleaseView } from "@gcpe/nrms-contract";
import { useAnnouncer } from "../../../shared/Announcer";
import { DragHandle, useDragReorder } from "../../../shared/useDragReorder";
import { useMoveFocusRestore } from "../../../shared/useMoveFocusRestore";
import { moveBy, moveTo } from "../../../shared/reorder";
import { RELOAD_MESSAGE, useReleaseSection } from "../useReleaseSection";
import { documentsInOrder } from "./documentHelpers";
import { orderedIds } from "./reorder";
import { DocumentTabs } from "./DocumentTabs";

export interface DocumentsSectionProps {
  view: ReleaseView;
  setView(v: ReleaseView): void;
  readOnly: boolean;
}

/**
 * The "Documents" section (task-4-brief.md): the release's documents, each with its own
 * English/French tabs (DocumentTabs.tsx); add/remove a document; reorder them both by drag and
 * by the keyboard-operable Move up/Move down buttons (constraints.md: every drag-reorder needs
 * a keyboard alternative) — both paths end up calling the same
 * `PUT .../documents/order {version, documentIds}`.
 */
export function DocumentsSection({ view, setView, readOnly }: DocumentsSectionProps): React.JSX.Element {
  const section = useReleaseSection(view, setView);
  const docs = documentsInOrder(view);
  const [adding, setAdding] = useState(false);
  const [newPageTitle, setNewPageTitle] = useState("");
  const [newLayout, setNewLayout] = useState<Layout>("formal");
  const [removeTarget, setRemoveTarget] = useState<string | null>(null);

  const enLang = view.languages.find((l) => l.languageId === LANG_EN);
  const { announce } = useAnnouncer();
  const moveFocus = useMoveFocusRestore();

  // I4: the Move buttons disable for the duration of this save — restore focus to the moved
  // document's own Move button (by id, since every later document's index/label just changed)
  // once the save settles and the DOM reflects the new order, rather than letting the browser
  // drop focus to <body> and leave it there. Keyed on `view` (not `docs`, a fresh array every
  // render) so it only runs once the server's response has actually landed; a harmless no-op
  // whenever nothing is pending.
  useEffect(() => {
    moveFocus.restore();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view]);

  const reorder = (next: string[]) => void section.save("/documents/order", { version: view.version, documentIds: next }, "PUT");
  const moveUp = (index: number) => {
    moveFocus.remember(docs[index]!.id, "up");
    announce(`Document ${index + 1} moved to position ${index}`);
    reorder(moveBy(orderedIds(docs), index, -1));
  };
  const moveDown = (index: number) => {
    moveFocus.remember(docs[index]!.id, "down");
    announce(`Document ${index + 1} moved to position ${index + 2}`);
    reorder(moveBy(orderedIds(docs), index, 1));
  };

  const dragReorder = useDragReorder({
    enabled: !readOnly && !section.saving,
    onReorder: (from, to) => reorder(moveTo(orderedIds(docs), from, to)),
  });

  const submitAdd = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    void section.save("/documents", { version: view.version, pageTitle: newPageTitle.trim(), layout: newLayout }, "POST").then((next) => {
      if (next) {
        setAdding(false);
        setNewPageTitle("");
        setNewLayout("formal");
      }
    });
  };

  const confirmRemove = async () => {
    if (!removeTarget) return;
    const next = await section.save(`/documents/${removeTarget}/remove`, { version: view.version }, "POST");
    if (next) setRemoveTarget(null);
  };

  return (
    <section className="gcpe-release-editor__documents" aria-label="Documents" id="section-documents" tabIndex={-1} ref={moveFocus.containerRef}>
      <h2>Documents</h2>

      <p className="gcpe-documents__summary-note">
        Summary: {enLang?.summary || "(none yet)"}
        {enLang && !enLang.summaryEdited ? " (auto)" : ""}
      </p>

      {section.conflict && <InlineAlert variant="danger" role="alert" description={RELOAD_MESSAGE} buttons={<Button onPress={() => void section.reload()}>Reload</Button>} />}
      {section.problems && (
        <ul role="alert" className="gcpe-release-editor__problems">
          {section.problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      )}
      {section.error && <InlineAlert variant="danger" role="alert" description={section.error} />}

      {docs.map((doc, index) => (
        <div key={doc.id} className="gcpe-documents__item" {...dragReorder.dropZoneProps(index)}>
          <div className="gcpe-documents__item-header">
            {!readOnly && <DragHandle reorder={dragReorder} index={index} label={`Drag to reorder document ${index + 1}`} />}
            <h3 id={`document-${index + 1}-heading`} tabIndex={-1}>
              Document {index + 1}
            </h3>
            {!readOnly && (
              <>
                <span data-move-id={doc.id} data-move-dir="up">
                  <Button size="small" variant="secondary" onPress={() => moveUp(index)} isDisabled={index === 0 || section.saving}>
                    <span>Move <span className="gcpe-visually-hidden">document {index + 1}</span> up</span>
                  </Button>
                </span>
                <span data-move-id={doc.id} data-move-dir="down">
                  <Button size="small" variant="secondary" onPress={() => moveDown(index)} isDisabled={index === docs.length - 1 || section.saving}>
                    <span>Move <span className="gcpe-visually-hidden">document {index + 1}</span> down</span>
                  </Button>
                </span>
                <DialogTrigger isOpen={removeTarget === doc.id} onOpenChange={(open) => setRemoveTarget(open ? doc.id : null)}>
                  <Button size="small" variant="secondary" danger isDisabled={section.saving || docs.length <= 1}>
                    <span>Remove <span className="gcpe-visually-hidden">document {index + 1}</span></span>
                  </Button>
                  <Modal isDismissable>
                    <AlertDialog
                      variant="destructive"
                      title={`Remove document ${index + 1}?`}
                      buttons={
                        <>
                          <Button onPress={() => setRemoveTarget(null)}>Cancel</Button>
                          <Button danger onPress={() => void confirmRemove()}>
                            Confirm remove
                          </Button>
                        </>
                      }
                    >
                      <p>This removes the document and every language and translation on it. It can&rsquo;t be undone.</p>
                    </AlertDialog>
                  </Modal>
                </DialogTrigger>
              </>
            )}
          </div>
          <DocumentTabs view={view} setView={setView} documentId={doc.id} readOnly={readOnly} />
        </div>
      ))}

      {!readOnly && !adding && <Button onPress={() => setAdding(true)}>Add document</Button>}
      {!readOnly && adding && (
        <form onSubmit={submitAdd} aria-label="Add document">
          <TextField label="Page title" value={newPageTitle} onChange={setNewPageTitle} isRequired maxLength={50} />
          <label>
            Layout
            <select value={newLayout} onChange={(e) => setNewLayout(e.target.value as Layout)}>
              {LAYOUTS.map((l) => (
                <option key={l} value={l}>
                  {l === "formal" ? "Formal" : "Informal"}
                </option>
              ))}
            </select>
          </label>
          <Button type="submit" isDisabled={section.saving}>
            Add
          </Button>
          <Button variant="secondary" onPress={() => setAdding(false)}>
            Cancel
          </Button>
        </form>
      )}
    </section>
  );
}

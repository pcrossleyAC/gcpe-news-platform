import { statusText, TYPE_LABEL, type ReleaseView } from "@gcpe/nrms-contract";
import { InlineAlert } from "@bcgov/design-system-react-components";
import { useDocumentTitle } from "../../../shared/useDocumentTitle";
import { headlineOf } from "../viewHelpers";
import { scrollToAndFocus } from "../../../shared/scrollToSection";
import { APPROVE_LIST_ID, readiness } from "../readiness";

export interface HeaderSectionProps {
  view: ReleaseView;
  /** NRMS.Editor: only an editor has Actions, so only an editor gets the "Not ready" line. */
  canEdit?: boolean;
}

/**
 * Spec's "Header and errors" section (task-3-brief.md): headline (the page's one `h1`), type,
 * status text, key/reference, `lastError` and the Flickr alert. For an editor, one line says how
 * many things are left to fix and links to the list under Actions (forms-b #16: the list is shown
 * once, there, with links). A viewer has no Actions, so no line (forms-b #13).
 */
export function HeaderSection({ view, canEdit = false }: HeaderSectionProps): React.JSX.Element {
  const ready = readiness(view);
  const left = ready.approve.length + ready.publish.length;
  const listId = ready.approve.length > 0 ? APPROVE_LIST_ID : ready.publishListId;
  useDocumentTitle(headlineOf(view) || "(untitled)");

  return (
    <header className="gcpe-release-editor__header">
      <p className="gcpe-release-editor__meta">
        <span className={`gcpe-release-row__bar gcpe-release-row__bar--${view.type}`} aria-hidden="true" />
        <span>{TYPE_LABEL[view.type]}</span>
        {" · "}
        <span>{statusText(view, Date.now())}</span>
        {view.reference && <> {"· "}<span>{view.reference}</span></>}
        {!view.reference && view.key && <> {"· "}<span>{view.key}</span></>}
      </p>

      <h1>{headlineOf(view) || "(untitled)"}</h1>

      {view.lastError && <InlineAlert variant="danger" role="alert" title="This release failed" description={view.lastError} />}
      {view.flickrAlert && <InlineAlert variant="warning" role="alert" title="Flickr alert" description={view.flickrAlert} />}

      {canEdit && left > 0 && (
        <p className="gcpe-release-editor__checklist">
          Not ready: {left} {left === 1 ? "thing" : "things"} to fix.{" "}
          <a
            href={`#${listId}`}
            onClick={(e) => {
              e.preventDefault();
              scrollToAndFocus(listId);
            }}
          >
            See them under Actions
          </a>
        </p>
      )}
    </header>
  );
}

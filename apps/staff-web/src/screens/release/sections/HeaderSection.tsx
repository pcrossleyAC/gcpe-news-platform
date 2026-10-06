import { approveProblems, publishProblems, statusText, TYPE_LABEL, type ReleaseView } from "@gcpe/nrms-contract";
import { InlineAlert } from "@bcgov/design-system-react-components";
import { useDocumentTitle } from "../../../shared/useDocumentTitle";
import { headlineOf } from "../viewHelpers";

export interface HeaderSectionProps {
  view: ReleaseView;
}

/**
 * Spec's "Header and errors" section (task-3-brief.md): headline (the page's one `h1`), type,
 * status text, key/reference, `lastError`, the Flickr alert, and the approve/publish checklists
 * — shown here, ahead of the Approve/Publish buttons in {@link ActionsSection} further down the
 * page, so the user sees what's missing before they even reach the button.
 */
export function HeaderSection({ view }: HeaderSectionProps): React.JSX.Element {
  const toApprove = approveProblems(view);
  const toPublish = publishProblems(view);
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

      {toApprove.length > 0 && (
        <div className="gcpe-release-editor__checklist">
          <p>Before this can be approved:</p>
          <ul>
            {toApprove.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        </div>
      )}

      {toPublish.length > 0 && (
        <div className="gcpe-release-editor__checklist">
          <p>Before this can be published:</p>
          <ul>
            {toPublish.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        </div>
      )}
    </header>
  );
}

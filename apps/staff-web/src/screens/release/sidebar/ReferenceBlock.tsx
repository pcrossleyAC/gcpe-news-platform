import type { ReleaseView } from "@gcpe/nrms-contract";

export interface ReferenceBlockProps {
  view: ReleaseView;
}

/**
 * The reference block (task-4-brief.md): key and reference. (The Calendar activity ID is shown,
 * and edited, once: in Publish settings.)
 * `view.reference` is already the legacy `NEWS-#####` number itself (verified against
 * apps/nrms/src/releases/queries.ts's `goTo`: a bare 5-digit search term is looked up as
 * `NEWS-<digits>`, and a release's `reference` column holds exactly that string) — assigned on
 * first approval, so it's `null` until then. Any field that isn't set yet is shown as
 * "(none yet)" rather than left blank.
 */
export function ReferenceBlock({ view }: ReferenceBlockProps): React.JSX.Element {
  return (
    <dl className="gcpe-sidebar__reference">
      <div>
        <dt>Key</dt>
        <dd>{view.key ?? "(none yet)"}</dd>
      </div>
      <div>
        <dt>Reference (NEWS number)</dt>
        <dd>{view.reference ?? "(none yet)"}</dd>
      </div>
    </dl>
  );
}

import type { ReleaseView } from "@gcpe/nrms-contract";
import { ReferenceBlock } from "./ReferenceBlock";
import { ViewLinks } from "./ViewLinks";
import { EmailCopy } from "./EmailCopy";
import { HistorySection } from "./HistorySection";

export interface SideBarProps {
  view: ReleaseView;
}

/** The release editor's side bar (task-4-brief.md): the reference block, View on
 * site/PDF links, Email me a copy, and the history/publications log. Everything here is
 * read-only — available to every signed-in staff role, not just Editors, which is why it takes
 * no `setView`/`readOnly` (unlike every other section on this page). */
export function SideBar({ view }: SideBarProps): React.JSX.Element {
  return (
    <aside className="gcpe-release-editor__sidebar" aria-label="Release info">
      <ReferenceBlock view={view} />
      <ViewLinks view={view} />
      <EmailCopy view={view} />
      <HistorySection view={view} />
    </aside>
  );
}

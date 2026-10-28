import { useEffect, useId, useRef } from "react";
import { SECTION_LABEL, type SectionKey } from "@gcpe/site-settings";
import { Button } from "../../../shared/BusyButton";
import { formatPublishedAt } from "./format";
import { sectionList, type SettingsEditor } from "./useSettingsEditor";

interface ConflictPanelProps {
  editor: SettingsEditor<unknown>;
  section: SectionKey;
  timeZone: string;
}

/**
 * Shown when Publish finds that someone else published first (spec "Hub screens", Conflict).
 * Takes focus when it appears: the editor has to choose before they can publish.
 */
export function ConflictPanel({ editor, section, timeZone }: ConflictPanelProps): React.JSX.Element | null {
  const headingId = useId();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const { conflict, pending, busy } = editor;

  useEffect(() => {
    if (conflict) headingRef.current?.focus();
  }, [conflict]);

  if (!conflict) return null;
  const { live, differing } = conflict;

  return (
    <section aria-labelledby={headingId} className="gcpe-settings-conflict">
      <h2 id={headingId} ref={headingRef} tabIndex={-1}>
        Someone published while you were editing
      </h2>
      <p>
        {live ? `Revision ${live.revision} was published by ${live.publishedBy} on ${formatPublishedAt(live.publishedAt, timeZone)}. ` : ""}
        Nothing of yours was published, and your draft is saved.
      </p>
      {differing.length > 0 && <p>{`Your draft differs from it in: ${sectionList(differing)}.`}</p>}
      <div className="gcpe-settings-conflict__actions">
        <Button onPress={() => void editor.rebase()} isPending={busy} pendingLabel={pending === "rebase" ? "Keeping your changes…" : undefined}>
          {`Keep my ${SECTION_LABEL[section].toLowerCase()}, on top of their version`}
        </Button>
        <Button variant="secondary" onPress={() => void editor.discard()} isPending={busy} pendingLabel={pending === "discard" ? "Discarding…" : undefined}>
          Discard mine, use theirs
        </Button>
      </div>
    </section>
  );
}

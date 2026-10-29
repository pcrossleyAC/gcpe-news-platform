import { useState } from "react";
import { InlineAlert, TextField } from "@bcgov/design-system-react-components";
import { Button } from "../../../shared/BusyButton";
import { useShortcut } from "../../../shared/shortcuts";
import { formatPublishedAt } from "./format";
import type { SettingsEditor } from "./useSettingsEditor";

interface PublishBarProps {
  editor: SettingsEditor<unknown>;
  /** NRMS.SiteEditor: without it (Core.Admin alone) the bar only reports what is live. */
  canEdit: boolean;
  timeZone: string;
}

/**
 * The foot of every site-settings editor (spec "Hub screens"): draft and live lines, the
 * history note, Discard draft (only with a draft) / Save draft / Publish, and the last status.
 */
export function PublishBar({ editor, canEdit, timeZone }: PublishBarProps): React.JSX.Element | null {
  const [note, setNote] = useState("");
  const { state, pending, busy } = editor;
  // ⌘/Ctrl+S is Save draft — never Publish, which changes the live site and keeps its own button.
  useShortcut("save", canEdit && state ? () => void (busy ? undefined : editor.saveDraft()) : null);
  if (!state) return null;

  const publish = () => {
    void editor.publish(note).then((published) => {
      if (published) setNote("");
    });
  };

  return (
    <div className="gcpe-settings-publish">
      <p>{state.draft ? "Draft saved · not yet live" : "No unpublished changes"}</p>
      <p>
        {state.live
          ? `Live: revision ${state.live.revision}, published by ${state.live.publishedBy} on ${formatPublishedAt(state.live.publishedAt, timeZone)}`
          : "Nothing published yet; the site uses its built-in defaults."}
      </p>
      {canEdit && (
        <>
          <TextField label="Note for the history log (optional)" value={note} onChange={setNote} maxLength={500} />
          <div className="gcpe-settings-publish__actions">
            {state.draft && (
              <Button variant="secondary" danger onPress={() => void editor.discard()} isPending={busy} pendingLabel={pending === "discard" ? "Discarding…" : undefined}>
                Discard draft
              </Button>
            )}
            <Button variant="secondary" onPress={() => void editor.saveDraft()} isPending={busy} pendingLabel={pending === "save" ? "Saving…" : undefined} shortcut="save">
              Save draft
            </Button>
            <Button onPress={publish} isPending={busy} pendingLabel={pending === "publish" ? "Publishing…" : undefined}>
              Publish
            </Button>
          </div>
        </>
      )}
      {editor.status && (
        <p ref={editor.statusRef} tabIndex={-1} className="gcpe-settings-publish__status">
          {editor.status}
        </p>
      )}
      {editor.error && <InlineAlert variant="danger" role="alert" description={editor.error} />}
    </div>
  );
}

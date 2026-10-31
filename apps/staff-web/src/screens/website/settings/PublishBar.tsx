import { Fragment, useState } from "react";
import { Link } from "react-router";
import { AlertDialog, DialogTrigger, InlineAlert, Modal, TextField } from "@bcgov/design-system-react-components";
import type { SectionKey } from "@gcpe/site-settings";
import { Button } from "../../../shared/BusyButton";
import { settingsScreenFor } from "../WebsiteScreen";
import { useShortcut } from "../../../shared/shortcuts";
import { formatPublishedAt } from "./format";
import { sectionList, type SettingsEditor } from "./useSettingsEditor";

interface PublishBarProps {
  editor: SettingsEditor<unknown>;
  /** NRMS.SiteEditor: without it (Core.Admin alone) the bar only reports what is live. */
  canEdit: boolean;
  timeZone: string;
}

const LIST = new Intl.ListFormat("en", { style: "long", type: "conjunction" });

/** What Discard draft's confirmation says it throws away (audit #12). */
function discardMessage(section: SectionKey, draftSections: readonly SectionKey[]): string {
  const others = draftSections.filter((k) => k !== section);
  const here = draftSections.includes(section);
  const parts = [
    ...(here ? [`This throws away your draft changes on ${settingsScreenFor(section).label}.`] : []),
    ...(others.length > 0 ? [`${here ? "This also throws away" : "This throws away"} your draft changes on ${sectionList(others)}.`] : []),
  ];
  return `${parts.length > 0 ? parts.join(" ") : "This throws away your draft."} It can\u2019t be undone.`;
}

/** "Your draft has changes on: Site banner, Theme colours, and Footer links." — each a link to its screen. */
function DraftScreens({ sections }: { sections: readonly SectionKey[] }): React.JSX.Element | null {
  if (sections.length === 0) return null;
  const parts = LIST.formatToParts(sections.map((k) => settingsScreenFor(k).label));
  let i = 0;
  return (
    <p>
      Your draft has changes on:{" "}
      {parts.map((part, n) => {
        if (part.type === "literal") return <Fragment key={n}>{part.value}</Fragment>;
        const screen = settingsScreenFor(sections[i++]!);
        return (
          <Link key={n} to={screen.path}>
            {screen.label}
          </Link>
        );
      })}
      .
    </p>
  );
}

/**
 * The foot of every site-settings editor (spec "Hub screens"): draft and live lines, the
 * history note, Discard draft (only with a draft) / Save draft / Publish, and the last status.
 */
export function PublishBar({ editor, canEdit, timeZone }: PublishBarProps): React.JSX.Element | null {
  const [note, setNote] = useState("");
  const [discardOpen, setDiscardOpen] = useState(false);
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
      {state.draft && <DraftScreens sections={state.draftSections} />}
      <p>
        {state.live
          ? `Live: revision ${state.live.revision}, published by ${state.live.publishedBy} on ${formatPublishedAt(state.live.publishedAt, timeZone)}`
          : "Nothing published yet; the site uses its built-in defaults."}
      </p>
      {canEdit && (
        <>
          <TextField label="Note for the history log (optional)" value={note} onChange={setNote} maxLength={500} />
          <p className="gcpe-hint">Publish and Discard draft apply to your whole draft, on every settings screen, not just this one.</p>
          <div className="gcpe-settings-publish__actions">
            {state.draft && (
              // Audit #12 (owner decision 2026-10-31): Discard draft asks first, naming the other
              // screens it clears. Once confirmed it discards exactly as before.
              <DialogTrigger isOpen={discardOpen} onOpenChange={setDiscardOpen}>
                <Button variant="secondary" danger isPending={busy} pendingLabel={pending === "discard" ? "Discarding…" : undefined}>
                  Discard draft
                </Button>
                <Modal isDismissable>
                  <AlertDialog
                    variant="destructive"
                    title="Discard your whole draft?"
                    buttons={
                      <>
                        <Button variant="secondary" onPress={() => setDiscardOpen(false)}>
                          Cancel
                        </Button>
                        <Button
                          danger
                          onPress={() => {
                            setDiscardOpen(false);
                            void editor.discard();
                          }}
                        >
                          Discard draft
                        </Button>
                      </>
                    }
                  >
                    <p>{discardMessage(editor.section, state.draftSections)}</p>
                  </AlertDialog>
                </Modal>
              </DialogTrigger>
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

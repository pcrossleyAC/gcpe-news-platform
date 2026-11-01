import { Fragment, useState } from "react";
import { Link } from "react-router";
import { AlertDialog, DialogTrigger, InlineAlert, Modal, TextField } from "@bcgov/design-system-react-components";
import { SECTION_KEYS, type SectionKey } from "@gcpe/site-settings";
import { Button } from "../../../shared/BusyButton";
import { afterDialogsClose } from "../../../shared/afterDialogsClose";
import { settingsScreenFor } from "../WebsiteScreen";
import { useShortcut } from "../../../shared/shortcuts";
import { formatPublishedAt } from "./format";
import { LeavePageGuard } from "../../../shared/LeaveGuard";
import { sectionList, sectionOfField, type SettingsEditor } from "./useSettingsEditor";

interface PublishBarProps {
  editor: SettingsEditor<unknown>;
  /** NRMS.SiteEditor: without it (Core.Admin alone) the bar only reports what is live. */
  canEdit: boolean;
  timeZone: string;
}

const LIST = new Intl.ListFormat("en", { style: "long", type: "conjunction" });

/** What Discard draft's confirmation says it throws away (audit #12). */
function discardMessage(section: SectionKey, draftSections: readonly SectionKey[], unsavedHere: boolean): string {
  const others = draftSections.filter((k) => k !== section);
  const first = [
    ...(draftSections.includes(section) ? [`your draft changes on ${settingsScreenFor(section).label}`] : []),
    ...(unsavedHere ? ["anything you haven\u2019t saved on this screen"] : []),
  ];
  const parts = [
    ...(first.length > 0 ? [`This throws away ${first.join(" and ")}.`] : []),
    ...(others.length > 0 ? [`${first.length > 0 ? "This also throws away" : "This throws away"} your draft changes on ${sectionList(others)}.`] : []),
  ];
  return `${parts.length > 0 ? parts.join(" ") : "This throws away your draft."} It can\u2019t be undone.`;
}

/**
 * W4 (owner decision 2026-10-31): what Publish's confirmation says, in the Restore confirmation's
 * words (HistoryScreen.tsx). `changed` are the screens whose changes would go live, this one
 * included when it has unsaved typing; `blocked` the other screens with problems.
 */
function PublishConsequences({ section, changed, blocked }: { section: SectionKey; changed: readonly SectionKey[]; blocked: readonly SectionKey[] }): React.JSX.Element {
  const label = settingsScreenFor(section).label;
  const others = changed.some((k) => k !== section);
  return (
    <>
      {changed.length === 0 ? (
        <p>Your draft is the same as what is live now. Publishing it makes a new revision with the same settings.</p>
      ) : (
        <p>{`Compared with what is live now, this publishes changes on: ${sectionList(changed)}.`}</p>
      )}
      {others && changed.includes(section) && <p>{`To publish only this screen and keep the other changes in your draft, choose Publish only ${label}.`}</p>}
      {blocked.length > 0 && changed.includes(section) && (
        <p>{`${sectionList(blocked)} ${blocked.length === 1 ? "has" : "have"} problems that block publishing all changes. Publish only ${label} still works.`}</p>
      )}
      <p>Visitors see it within a few minutes.</p>
    </>
  );
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
  const [publishOpen, setPublishOpen] = useState(false);
  const { state, pending, busy } = editor;
  // ⌘/Ctrl+S is Save draft — never Publish, which changes the live site and keeps its own button.
  useShortcut("save", canEdit && state ? () => void (busy ? undefined : editor.saveDraft()) : null);
  if (!state) return null;

  // As Discard draft: the confirmation closes and the publish starts at once; its result is
  // announced once the dialog has gone (afterDialogsClose), so a screen reader hears it.
  const publish = (onlySection: boolean) => {
    setPublishOpen(false);
    void editor.publish(note, onlySection, afterDialogsClose).then((published) => {
      if (published) setNote("");
    });
  };
  const section = editor.section;
  const drafted = state.draftSections ?? [];
  const changed = SECTION_KEYS.filter((k) => drafted.includes(k) || (k === section && editor.dirty));
  const blocked = SECTION_KEYS.filter((k) => k !== section && editor.otherErrors.some((e) => sectionOfField(e.field) === k));
  const offerOnly = changed.includes(section) && changed.some((k) => k !== section);
  const label = settingsScreenFor(section).label;

  return (
    <div className="gcpe-settings-publish">
      {/* Suite review W9: changes not yet saved as a draft ask before leaving this screen. */}
      <LeavePageGuard dirty={editor.dirty} />
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
          <p className="gcpe-hint">Publish and Discard draft apply to your whole draft, on every settings screen. Publish lets you publish only this screen instead.</p>
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
                    <p>{discardMessage(editor.section, state.draftSections, editor.dirty)}</p>
                  </AlertDialog>
                </Modal>
              </DialogTrigger>
            )}
            <Button variant="secondary" onPress={() => void editor.saveDraft()} isPending={busy} pendingLabel={pending === "save" ? "Saving…" : undefined} shortcut="save">
              Save draft
            </Button>
            {/* W4 (owner decision 2026-10-31): Publish asks first, naming what goes live. */}
            <DialogTrigger isOpen={publishOpen} onOpenChange={setPublishOpen}>
              <Button isPending={busy} pendingLabel={pending === "publish" ? "Publishing…" : undefined}>
                Publish
              </Button>
              <Modal isDismissable>
                <AlertDialog
                  variant="warning"
                  title="Publish your changes?"
                  // The design system's title is a plain div, so without this the dialog has no accessible name.
                  aria-label="Publish your changes?"
                  buttons={
                    <>
                      <Button variant="secondary" onPress={() => setPublishOpen(false)}>
                        Cancel
                      </Button>
                      {offerOnly && (
                        <Button variant="secondary" onPress={() => publish(true)}>
                          {`Publish only ${label}`}
                        </Button>
                      )}
                      <Button onPress={() => publish(false)}>{offerOnly ? "Publish all changes" : "Publish"}</Button>
                    </>
                  }
                >
                  <PublishConsequences section={section} changed={changed} blocked={blocked} />
                </AlertDialog>
              </Modal>
            </DialogTrigger>
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

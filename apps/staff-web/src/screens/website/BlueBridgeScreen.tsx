import { useCallback, useEffect, useState } from "react";
import { AlertDialog, Button, Checkbox, InlineAlert, Modal, Switch, TextField } from "@bcgov/design-system-react-components";
import { apiFetch } from "../../api/client";
import { useSession } from "../../session/SessionContext";
import { useDocumentTitle } from "../../shared/useDocumentTitle";
import { useIsTestSite } from "./useIsTestSite";
import { RELOAD_MESSAGE, useVersionedSave } from "./useVersionedSave";
import type { BlueBridgeView } from "./types";

/** apps/nrms/src/website/settings.ts's CONFIRMATION_PHRASE — the server trims and compares
 * case-sensitively, so the client's enable check mirrors exactly that (never looser). */
const CONFIRMATION_PHRASE = "KING CHARLES III";

/**
 * `/hub/website/blue-bridge` (task-5-brief.md): the `granville` mourning-banner switch. Only
 * `Core.Admin` sees the switch at all — every other read role (including `NRMS.SiteEditor`,
 * who reaches this screen to edit everything else in Website) sees the current state and the
 * legacy warning text, read-only.
 */
export function BlueBridgeScreen(): React.JSX.Element {
  const session = useSession();
  useDocumentTitle("Project Blue Bridge");
  const isAdmin = session.has("Core.Admin");
  const isTestSite = useIsTestSite();
  const section = useVersionedSave<BlueBridgeView>();
  const [state, setState] = useState<BlueBridgeView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [pendingOn, setPendingOn] = useState(false);
  const [confirmation, setConfirmation] = useState("");
  const [acknowledgeIgrs, setAcknowledgeIgrs] = useState(false);

  const reload = useCallback(() => {
    apiFetch<BlueBridgeView>("/nrms/api/site/blue-bridge").then(setState, () => setLoadError("Couldn't load Project Blue Bridge."));
  }, []);

  useEffect(reload, [reload]);

  const openDialog = (nextOn: boolean) => {
    setPendingOn(nextOn);
    setConfirmation("");
    setAcknowledgeIgrs(false);
    setDialogOpen(true);
  };

  const confirmEnabled = confirmation.trim() === CONFIRMATION_PHRASE && acknowledgeIgrs;

  const onConfirm = () => {
    if (!state || !confirmEnabled) return;
    void section
      .run(() => apiFetch<BlueBridgeView>("/nrms/api/site/blue-bridge", { method: "PUT", body: { version: state.version, on: pendingOn, confirmation, acknowledgeIgrs } }))
      .then((next) => {
        if (next) {
          setState(next);
          setDialogOpen(false);
        }
      });
  };

  if (loadError) {
    return (
      <div className="gcpe-blue-bridge">
        <h1>Project Blue Bridge</h1>
        <InlineAlert variant="danger" role="alert" description={loadError} />
      </div>
    );
  }
  if (!state) return <p>Loading…</p>;

  return (
    <div className="gcpe-blue-bridge">
      <h1>Project Blue Bridge</h1>

      {isTestSite && <InlineAlert variant="warning" description="This is a TEST site." />}
      <p>{state.warning}</p>
      <p>Project Blue Bridge is currently {state.on ? "ON" : "OFF"}.</p>

      {section.conflict && <InlineAlert variant="danger" role="alert" description={RELOAD_MESSAGE} buttons={<Button onPress={reload}>Reload</Button>} />}
      {section.problems && (
        <ul role="alert" className="gcpe-release-editor__problems">
          {section.problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      )}
      {section.error && <InlineAlert variant="danger" role="alert" description={section.error} />}

      {isAdmin && (
        <>
          <Switch isSelected={state.on} isDisabled={section.saving} onChange={openDialog}>
            Project Blue Bridge
          </Switch>

          {/* Same pattern as ReleaseEditorPage.tsx's unsaved-changes dialog: a directly
           * controlled Modal/AlertDialog, not a DialogTrigger — the Switch above (not a click
           * on the dialog's own trigger) is what opens this. */}
          <Modal isOpen={dialogOpen} onOpenChange={(open) => { if (!open) setDialogOpen(false); }} isDismissable>
            <AlertDialog
              variant="warning"
              title={`Turn Project Blue Bridge ${pendingOn ? "on" : "off"}?`}
              buttons={
                <>
                  <Button onPress={() => setDialogOpen(false)}>Cancel</Button>
                  <Button danger onPress={onConfirm} isDisabled={!confirmEnabled || section.saving}>
                    Confirm {pendingOn ? "turn on" : "turn off"}
                  </Button>
                </>
              }
            >
              <p>{state.warning}</p>
              <TextField label={`Type ${CONFIRMATION_PHRASE} to confirm`} value={confirmation} onChange={setConfirmation} />
              <Checkbox isSelected={acknowledgeIgrs} onChange={setAcknowledgeIgrs}>
                IGRS has approved this change
              </Checkbox>
            </AlertDialog>
          </Modal>
        </>
      )}
    </div>
  );
}

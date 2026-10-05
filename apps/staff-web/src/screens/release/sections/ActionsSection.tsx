import { useState } from "react";
import { useNavigate } from "react-router";
import { AlertDialog, Button, DialogTrigger, InlineAlert, Modal } from "@bcgov/design-system-react-components";
import { approveProblems, publishProblems, typeRules, type ReleaseView } from "@gcpe/nrms-contract";
import { apiFetch, ApiError } from "../../../api/client";
import { RELOAD_MESSAGE, useReleaseSection } from "../useReleaseSection";
import { useRegisterDirty } from "../useUnsavedChanges";
import { SchedulePicker, type ScheduleValue } from "./SchedulePicker";

/** apps/nrms/src/releases/service.ts's DELETABLE_STATUSES. */
const DELETABLE_STATUSES = new Set(["draft", "approved", "failed"]);
/** apps/nrms/src/releases/workflow.ts's UNPUBLISHABLE_STATUSES. */
const UNPUBLISHABLE_STATUSES = new Set(["published", "publishing", "failed", "scheduled"]);

export interface ActionsSectionProps {
  view: ReleaseView;
  setView(v: ReleaseView): void;
  timeZone: string;
}

/**
 * Editors-only (the caller gates this whole section on `NRMS.Editor`): Approve, Publish
 * now/Schedule, Cancel schedule, Unpublish (hidden when the type isn't unpublishable — e.g.
 * Advisory), Delete. Button visibility mirrors apps/nrms/src/releases/workflow.ts's status
 * preconditions; the server remains the authority (constraints.md) — these are convenience
 * gates, not the enforcement.
 */
export function ActionsSection({ view, setView, timeZone }: ActionsSectionProps): React.JSX.Element {
  const navigate = useNavigate();
  const section = useReleaseSection(view, setView);
  const rules = typeRules(view.type);

  const [schedulerOpen, setSchedulerOpen] = useState(false);
  const [scheduleValue, setScheduleValue] = useState<ScheduleValue | null>(null);
  useRegisterDirty("actions-scheduler", schedulerOpen);

  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteConflict, setDeleteConflict] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const [unpublishOpen, setUnpublishOpen] = useState(false);

  const canApprove = view.status === "draft";
  const canPublish = (view.status === "approved" || view.status === "failed") && view.key !== null;
  const needsKeyFirst = (view.status === "approved" || view.status === "failed") && view.key === null;
  const canCancel = view.status === "scheduled";
  const canUnpublish = rules.unpublishable && view.releasedAt !== null && UNPUBLISHABLE_STATUSES.has(view.status);
  const canDelete = DELETABLE_STATUSES.has(view.status);

  const approve = () => void section.save("/approve", { version: view.version }, "POST");
  const publishNow = () => void section.save("/schedule", { version: view.version, publishAt: "now" }, "POST");
  const cancelSchedule = () => void section.save("/cancel", { version: view.version }, "POST");
  const unpublish = () =>
    void section.save("/unpublish", { version: view.version }, "POST").then((next) => {
      if (next) setUnpublishOpen(false);
    });

  const submitSchedule = async () => {
    if (!scheduleValue) return;
    // Fix round 1, finding 3: sends the raw BC wall-clock string (`publishAtLocal`), not a
    // client-converted instant — the server (whose tzdata is authoritative) converts it.
    const result = await section.save("/schedule", { version: view.version, publishAtLocal: scheduleValue.local }, "POST");
    if (result) {
      setSchedulerOpen(false);
      setScheduleValue(null);
    }
  };

  const confirmDelete = async () => {
    setDeleting(true);
    setDeleteError(null);
    setDeleteConflict(false);
    try {
      await apiFetch(`/nrms/api/releases/${view.id}/delete`, { method: "POST", body: { version: view.version } });
      navigate("/releases/drafts");
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 409) setDeleteConflict(true);
      else setDeleteError(caught instanceof ApiError ? caught.message : "Delete failed.");
    } finally {
      setDeleting(false);
    }
  };

  return (
    <section className="gcpe-release-editor__actions" aria-label="Actions">
      <h2>Actions</h2>

      {section.conflict && (
        <InlineAlert variant="danger" role="alert" description={RELOAD_MESSAGE} buttons={<Button onPress={() => void section.reload()}>Reload</Button>} />
      )}
      {section.error && <InlineAlert variant="danger" role="alert" description={section.error} />}
      {section.problems && (
        <ul role="alert" className="gcpe-release-editor__problems">
          {section.problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      )}

      <div className="gcpe-release-editor__action-buttons">
        {canApprove && (
          <Button onPress={approve} isDisabled={section.saving || approveProblems(view).length > 0}>
            Approve
          </Button>
        )}

        {canPublish && (
          <>
            <Button onPress={publishNow} isDisabled={section.saving || publishProblems(view).length > 0}>
              Publish now
            </Button>
            <Button variant="secondary" onPress={() => setSchedulerOpen((o) => !o)} isDisabled={publishProblems(view).length > 0}>
              Schedule
            </Button>
          </>
        )}
        {needsKeyFirst && <p>Set a URL key in Page details before this can be published.</p>}

        {canCancel && (
          <Button variant="secondary" onPress={cancelSchedule} isDisabled={section.saving}>
            Cancel schedule
          </Button>
        )}

        {canUnpublish && (
          // Minors: this takes a public release down — a confirm dialog, same pattern as
          // Delete, instead of firing the POST straight from the button press.
          <DialogTrigger isOpen={unpublishOpen} onOpenChange={setUnpublishOpen}>
            <Button variant="secondary" isDisabled={section.saving}>
              Unpublish
            </Button>
            <Modal isDismissable>
              <AlertDialog
                variant="warning"
                title="Unpublish this release?"
                buttons={
                  <>
                    <Button onPress={() => setUnpublishOpen(false)} isDisabled={section.saving}>
                      Cancel
                    </Button>
                    <Button danger onPress={unpublish} isDisabled={section.saving}>
                      Confirm unpublish
                    </Button>
                  </>
                }
              >
                <p>This takes the release down from the public site and the News API. It can be republished afterwards.</p>
              </AlertDialog>
            </Modal>
          </DialogTrigger>
        )}

        {canDelete && (
          // Fix round 1, finding 2: a real Modal/AlertDialog (React Aria's ModalOverlay under
          // the hood), wrapped in a DialogTrigger so focus restoration on close is tied to
          // *this* trigger button specifically — instead of a bare `<div role="dialog">`, which
          // left other action buttons clickable, trapped no focus, and restored nothing.
          <DialogTrigger isOpen={deleteOpen} onOpenChange={setDeleteOpen}>
            <Button variant="secondary" danger isDisabled={section.saving}>
              Delete
            </Button>
            <Modal isDismissable>
              <AlertDialog
                variant="destructive"
                title="Delete this release?"
                buttons={
                  <>
                    <Button onPress={() => setDeleteOpen(false)} isDisabled={deleting}>
                      Cancel
                    </Button>
                    <Button danger onPress={() => void confirmDelete()} isDisabled={deleting}>
                      Confirm delete
                    </Button>
                  </>
                }
              >
                <p>
                  {view.reference
                    ? `This release has a reference number (${view.reference}) — deleting it hides it from the lists but keeps the record.`
                    : "This draft has never been approved — deleting it is permanent and can't be undone."}
                </p>
                {deleteConflict && <InlineAlert variant="danger" role="alert" description={RELOAD_MESSAGE} />}
                {deleteError && <InlineAlert variant="danger" role="alert" description={deleteError} />}
              </AlertDialog>
            </Modal>
          </DialogTrigger>
        )}
      </div>

      {schedulerOpen && canPublish && (
        <div className="gcpe-release-editor__scheduler">
          <SchedulePicker timeZone={timeZone} legend="Schedule for" idPrefix="schedule" onChange={setScheduleValue} />
          <Button onPress={() => void submitSchedule()} isDisabled={!scheduleValue || section.saving}>
            Confirm schedule
          </Button>
        </div>
      )}
    </section>
  );
}

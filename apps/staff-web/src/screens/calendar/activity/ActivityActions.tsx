import { useState } from "react";
import { Link } from "react-router";
import { AlertDialog, Button, InlineAlert, Modal } from "@bcgov/design-system-react-components";
import type { ActivityView, FieldError } from "@gcpe/calendar-contract";
import { ApiError } from "../../../api/client";
import { WatchStar, type WatchState } from "../list/WatchStar";
import { activityApi } from "./api";
import { minIdOf } from "./form";
import { activityPath, changesPath } from "./paths";

/** The server's own reason: a 422 names its fields (a clone's ministry or contact gone inactive), a 404 means the activity has gone. */
function refusal(e: unknown): string | null {
  if (!(e instanceof ApiError)) return "Couldn't reach the server. Try again.";
  // apiFetch is already sending the user to sign in.
  if (e.status === 401) return null;
  if (e.status === 404) return "This activity is no longer available.";
  const named = e.status === 422 ? ((e.body as { errors?: FieldError[] } | undefined)?.errors ?? []) : [];
  return named.length ? named.map((f) => f.message).join(" ") : e.message;
}

/**
 * Review, Clone, Delete, the watch star and View changes (spec addendum §8.2), each offered only as
 * the view's `can` allows. Review and Clone act on the stored activity, so they wait for unsaved
 * changes to be saved or cancelled; Delete asks first and discards them. The change freeze leaves
 * only Review, the star and View changes (§7.4); a deleted activity offers only Review (§6).
 */
export function ActivityActions({ view, myName, dirty, frozen, deletable, reload, returnTo, leave, onWatch }: {
  view: ActivityView;
  myName: string;
  dirty: boolean;
  frozen: boolean;
  /** False when a delete would be refused anyway: someone else's lock, or the activity gone. */
  deletable: boolean;
  /** Fetches the stored activity again, as Save's Reload does, after a version conflict. */
  reload: () => Promise<void>;
  returnTo: string;
  leave: (to: string, notice: string, replace?: boolean) => void;
  onWatch: (w: WatchState) => void;
}): React.JSX.Element {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ text: string; conflict: boolean } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const ref = minIdOf(view);
  const act = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      const text = refusal(e);
      setError(text === null ? null : { text, conflict: e instanceof ApiError && e.status === 409 && e.code === "version_conflict" });
    } finally {
      setBusy(false);
    }
  };
  return (
    <section aria-label="Activity actions" className="gcpe-actions gcpe-activity-actions">
      {!view.isDeleted && (
        <>
          <WatchStar id={view.id} label={ref} watch={view.watch} myName={myName} onChange={onWatch} />
          <Link to={changesPath(view.id, returnTo)}>View changes</Link>
        </>
      )}
      {view.can.review && (
        <Button
          variant="secondary"
          isDisabled={busy || dirty}
          onPress={() =>
            void act(async () => {
              await activityApi.review(view.id, view.version);
              leave(returnTo, `Reviewed ${ref}.`, true);
            })
          }
        >
          Review
        </Button>
      )}
      {view.can.clone && !frozen && (
        <Button
          variant="secondary"
          isDisabled={busy || dirty}
          onPress={() =>
            void act(async () => {
              const r = await activityApi.clone(view.id);
              // A clone the user can't see (as a save's result can be) is reported from the list.
              if (r.activity) leave(activityPath(r.id, returnTo), `Cloned ${ref} as ${minIdOf(r.activity)}.`);
              else leave(returnTo, `Cloned ${ref}.`);
            })
          }
        >
          Clone
        </Button>
      )}
      {view.can.delete && !frozen && deletable && (
        <Button variant="secondary" danger isDisabled={busy} onPress={() => setConfirmDelete(true)}>
          Delete
        </Button>
      )}
      {dirty && (view.can.review || view.can.clone) && <p className="gcpe-hint">Save or cancel your changes to review or clone.</p>}
      {error && (
        <InlineAlert
          variant="danger"
          role="alert"
          description={error.text}
          buttons={
            error.conflict ? (
              <Button
                variant="secondary"
                onPress={() =>
                  void reload().then(() => {
                    setError(null);
                  })
                }
              >
                Reload
              </Button>
            ) : undefined
          }
        />
      )}
      <Modal isOpen={confirmDelete} onOpenChange={setConfirmDelete} isDismissable>
        <AlertDialog
          role="alertdialog"
          aria-label={`Delete ${ref}?`}
          variant="destructive"
          title={`Delete ${ref}?`}
          buttons={
            <>
              <Button variant="secondary" onPress={() => setConfirmDelete(false)}>
                Cancel
              </Button>
              <Button
                danger
                onPress={() => {
                  setConfirmDelete(false);
                  void act(async () => {
                    await activityApi.remove(view.id, view.version);
                    leave(returnTo, `Deleted ${ref}.`, true);
                  });
                }}
              >
                Delete
              </Button>
            </>
          }
        >
          <p>It leaves the list for everyone but HQ Administrators, who can review the deletion. Any unsaved changes are discarded.</p>
        </AlertDialog>
      </Modal>
    </section>
  );
}

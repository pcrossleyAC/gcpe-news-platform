import { useCallback, useEffect, useRef, useState } from "react";
import { AlertDialog, InlineAlert, Modal } from "@bcgov/design-system-react-components";
import { ApiError } from "../../../api/client";
import { useTenantTimeZone } from "../../../format/tenantTimeZone";
import { useSession } from "../../../session/SessionContext";
import { useAnnouncer } from "../../../shared/Announcer";
import { Button } from "../../../shared/BusyButton";
import { useDocumentTitle } from "../../../shared/useDocumentTitle";
import { canManageWebsite } from "../access";
import { getHistory, getRevision, restoreRevision, type HistoryList, type PublishConflict, type RevisionDetail } from "./api";
import { formatPublishedAt } from "./format";
import { sectionList } from "./useSettingsEditor";

const TITLE = "Settings history";

/** What the confirmation is asking about: the revision, and the live revision it was compared with. */
interface Confirmation {
  detail: RevisionDetail;
  /** The live revision shown when the confirmation opened — the restore's concurrency token. */
  baseRevision: number;
}

/** "The banner would be: Emergency, “Wildfire”." / "The banner would be: Off." */
function bannerSummary({ banner }: RevisionDetail["document"]): string {
  return banner.enabled ? `The banner would be: ${banner.style === "emergency" ? "Emergency" : "Information"}, “${banner.message}”.` : "The banner would be: Off.";
}

/**
 * `/hub/website/settings-history` (spec "Hub screens", Settings history): every published
 * revision, newest first, and Restore… (which publishes an old revision again as a new one).
 * Reads need NRMS.SiteEditor or Core.Admin; Restore needs NRMS.SiteEditor.
 */
export function HistoryScreen(): React.JSX.Element {
  const session = useSession();
  useDocumentTitle(TITLE);
  if (!canManageWebsite(session)) {
    return (
      <div className="gcpe-site-history">
        <h1>{TITLE}</h1>
        <p>You don&rsquo;t have permission to view the settings history.</p>
      </div>
    );
  }
  return <HistoryTable canEdit={session.has("NRMS.SiteEditor")} />;
}

function HistoryTable({ canEdit }: { canEdit: boolean }): React.JSX.Element {
  const timeZone = useTenantTimeZone();
  const { announce } = useAnnouncer();
  const [history, setHistory] = useState<HistoryList | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [opening, setOpening] = useState<number | null>(null);
  const [restoring, setRestoring] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const statusRef = useRef<HTMLParagraphElement>(null);
  const [focusStatus, setFocusStatus] = useState(0);

  const load = useCallback(async () => {
    try {
      setHistory(await getHistory());
      setLoadError(null);
    } catch {
      setLoadError("Couldn't load the settings history.");
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    if (focusStatus > 0) statusRef.current?.focus();
  }, [focusStatus]);

  const say = (message: string) => {
    setStatus(message);
    announce(message);
    setFocusStatus((n) => n + 1);
  };

  const open = async (revision: number) => {
    if (!history || history.live === null) return;
    const baseRevision = history.live;
    setOpening(revision);
    setError(null);
    setStatus(null);
    try {
      setConfirmation({ detail: await getRevision(revision), baseRevision });
    } catch (caught) {
      setError(caught instanceof ApiError && caught.status === 404 ? `Revision ${revision} no longer exists.` : "Couldn't load that revision. Try again.");
    } finally {
      setOpening(null);
    }
  };

  const restore = async () => {
    if (!confirmation) return;
    const { detail, baseRevision } = confirmation;
    const revision = detail.info.revision;
    setRestoring(true);
    setError(null);
    try {
      const result = await restoreRevision({ revision, baseRevision });
      setConfirmation(null);
      await load();
      say(`Revision ${revision} is live again, as revision ${result.revision}.`);
    } catch (caught) {
      setConfirmation(null);
      if (caught instanceof ApiError && caught.status === 409 && caught.code === "published") {
        const { live } = caught.body as PublishConflict;
        await load();
        say(`Nothing was restored: revision ${live?.revision ?? "a newer one"} was published while you were looking. Check it and try again.`);
      } else if (caught instanceof ApiError && caught.status === 404) {
        await load();
        setError(`Revision ${revision} no longer exists.`);
      } else if (caught instanceof ApiError && caught.status === 422) {
        setError(`Revision ${revision} can't be restored: it doesn't pass the checks the site settings must meet now.`);
      } else {
        setError("Something went wrong. Nothing was restored. Try again.");
      }
    } finally {
      setRestoring(false);
    }
  };

  if (loadError) {
    return (
      <div className="gcpe-site-history">
        <h1>{TITLE}</h1>
        <InlineAlert variant="danger" role="alert" description={loadError} />
      </div>
    );
  }
  if (!history) {
    return (
      <div className="gcpe-site-history">
        <h1>{TITLE}</h1>
        <p>Loading…</p>
      </div>
    );
  }

  return (
    <div className="gcpe-site-history">
      <h1>{TITLE}</h1>

      {status && (
        <p ref={statusRef} tabIndex={-1} className="gcpe-settings-publish__status">
          {status}
        </p>
      )}
      {error && <InlineAlert variant="danger" role="alert" description={error} />}

      {history.revisions.length === 0 ? (
        <p>Nothing has been published yet; the site uses its built-in defaults.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th scope="col">Revision</th>
              <th scope="col">When</th>
              <th scope="col">Who</th>
              <th scope="col">Note</th>
              <th scope="col">Actions</th>
            </tr>
          </thead>
          <tbody>
            {history.revisions.map((r) => (
              <tr key={r.revision}>
                <td>
                  {r.revision}
                  {r.revision === history.live && <strong> Live</strong>}
                </td>
                <td>{formatPublishedAt(r.publishedAt, timeZone)}</td>
                <td>{r.publishedBy}</td>
                <td>{r.note}</td>
                <td>
                  {canEdit && r.revision !== history.live && (
                    <Button
                      variant="secondary"
                      aria-label={`Restore… revision ${r.revision}`}
                      onPress={() => void open(r.revision)}
                      isPending={opening !== null}
                    >
                      Restore…
                    </Button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <Modal isOpen={confirmation !== null} onOpenChange={(isOpen) => { if (!isOpen && !restoring) setConfirmation(null); }} isDismissable>
        {confirmation && (
          <AlertDialog
            variant="warning"
            title={`Restore revision ${confirmation.detail.info.revision}?`}
            // The design system's title is a plain div, so without this the dialog has no accessible name.
            aria-label={`Restore revision ${confirmation.detail.info.revision}?`}
            buttons={
              <>
                <Button variant="secondary" onPress={() => setConfirmation(null)} isDisabled={restoring}>
                  Cancel
                </Button>
                <Button onPress={() => void restore()} isPending={restoring} pendingLabel="Restoring…">
                  {`Restore revision ${confirmation.detail.info.revision}`}
                </Button>
              </>
            }
          >
            <Consequences detail={confirmation.detail} />
          </AlertDialog>
        )}
      </Modal>
    </div>
  );
}

function Consequences({ detail }: { detail: RevisionDetail }): React.JSX.Element {
  const { differing } = detail;
  return (
    <>
      {differing.length === 0 ? (
        <p>{`Revision ${detail.info.revision} is identical to what is live now. Restoring it publishes the same settings again as a new revision.`}</p>
      ) : (
        <p>{`Compared with what is live now, this changes: ${sectionList(differing)}.`}</p>
      )}
      {differing.includes("banner") && <p>{bannerSummary(detail.document)}</p>}
      <p>It is published again as a new revision, and visitors see it within a few minutes.</p>
    </>
  );
}

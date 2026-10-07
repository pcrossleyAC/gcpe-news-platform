import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import { Button, InlineAlert } from "@bcgov/design-system-react-components";
import { apiFetch, ApiError } from "../../api/client";
import { formatWhen } from "../../format/dates";
import { useTenantTimeZone } from "../../format/tenantTimeZone";
import { useSession } from "../../session/SessionContext";
import { useDocumentTitle } from "../../shared/useDocumentTitle";
import { canEditSubscribers } from "./access";
import { describeSync, mediaErrorText } from "./labels";
import type { MediaListSummary, SyncResultView, SyncStatus } from "./types";

/** `/hub/subscribers/media-lists`: every media list (names from NRMS), its member and
 * needs-attention counts, and the nightly Media Hub sync's last result. Editors can run the
 * sync now. */
export function MediaListsScreen(): React.JSX.Element {
  useDocumentTitle("Media lists");
  const session = useSession();
  const canEdit = canEditSubscribers(session);
  const timeZone = useTenantTimeZone();
  const [lists, setLists] = useState<MediaListSummary[] | null>(null);
  const [sync, setSync] = useState<SyncStatus | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Only the latest load may land: a reload after a sync must not be overwritten by the
  // slower first load that started before it.
  const latest = useRef(0);
  const reload = useCallback(() => {
    const seq = ++latest.current;
    Promise.all([apiFetch<MediaListSummary[]>("/nod/api/media-lists"), apiFetch<SyncStatus>("/nod/api/media-hub/sync")]).then(
      ([l, s]) => {
        if (seq !== latest.current) return;
        setLists(l);
        setSync(s);
        setLoadError(null);
      },
      () => {
        if (seq === latest.current) setLoadError("Couldn't load media lists.");
      },
    );
  }, []);
  useEffect(() => reload(), [reload]);

  const runSync = async () => {
    setBusy(true);
    setSyncError(null);
    setMessage(null);
    try {
      const r = await apiFetch<{ done: boolean; result: SyncResultView }>("/nod/api/media-hub/sync", { method: "POST" });
      setMessage(r.done ? `Sync finished. ${describeSync(r.result)}` : `Sync stopped part-way and carries on at the next scheduled run. ${describeSync(r.result)}`);
      reload();
    } catch (e) {
      setSyncError(e instanceof ApiError && e.status === 409 ? "A sync is already running. Try again in a few minutes." : mediaErrorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="gcpe-subscribers__media-lists">
      <h1>Media lists</h1>
      {loadError && <InlineAlert variant="danger" role="alert" description={loadError} />}
      {session.has("Core.Admin") && (
        <p>
          <Link to="/media-list-names">Manage media list names</Link>
        </p>
      )}
      {!lists && !loadError && <p>Loading…</p>}
      {lists && lists.length === 0 && <p>No media lists yet.</p>}
      {lists && lists.length > 0 && (
        <table aria-label="Media lists">
          <thead>
            <tr>
              <th scope="col">List</th>
              <th scope="col">Members</th>
              <th scope="col">Need attention</th>
              <th scope="col">Status</th>
            </tr>
          </thead>
          <tbody>
            {lists.map((l) => (
              <tr key={l.listKey}>
                <td>
                  <Link to={`/subscribers/media-lists/${encodeURIComponent(l.key)}`}>{l.name}</Link>
                </td>
                <td>{l.members}</td>
                <td>{l.needsAttention}</td>
                <td>{l.active ? "Active" : "Retired"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <section aria-labelledby="media-sync-heading">
        <h2 id="media-sync-heading">Media Hub sync</h2>
        {sync && (
          <>
            <p>{`Last run: ${sync.at ? formatWhen(sync.at, new Date(), timeZone) : "never"}.`}</p>
            <p>{describeSync(sync.result)}</p>
            {sync.running && <p>A sync is running now.</p>}
          </>
        )}
        {message && <p role="status">{message}</p>}
        {syncError && <InlineAlert variant="danger" role="alert" description={syncError} />}
        {canEdit && (
          <Button variant="secondary" onPress={() => void runSync()} isDisabled={busy}>
            Sync with Media Hub now
          </Button>
        )}
      </section>
    </div>
  );
}

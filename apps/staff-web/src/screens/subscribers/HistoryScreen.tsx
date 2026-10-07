import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router";
import { InlineAlert } from "@bcgov/design-system-react-components";
import { apiFetch, ApiError } from "../../api/client";
import { formatWhen } from "../../format/dates";
import { useTenantTimeZone } from "../../format/tenantTimeZone";
import { useDocumentTitle } from "../../shared/useDocumentTitle";
import { actorLabel, historyLabel } from "./labels";
import type { HistoryEntry } from "./types";

/** apps/nod/src/staff-subscribers/read.ts's HISTORY_LIMIT — the server sends `truncated` but
 * not the limit itself, so the exact count in the notice below is this constant, not a value
 * read from the response. */
const HISTORY_LIMIT = 500;

/** `/hub/subscribers/:id/history` (legacy SubscriberHistory.aspx): read-only, newest first —
 * apps/nod/src/staff-subscribers/read.ts's listHistory already orders it that way. */
export function HistoryScreen(): React.JSX.Element {
  const { id = "" } = useParams();
  const timeZone = useTenantTimeZone();
  useDocumentTitle("Subscriber history");

  const [items, setItems] = useState<HistoryEntry[] | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [notFound, setNotFound] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const reload = useCallback(() => {
    apiFetch<{ items: HistoryEntry[]; truncated?: boolean }>(`/nod/api/subscribers/${id}/history`).then(
      (r) => {
        setItems(r.items);
        setTruncated(r.truncated ?? false);
        setNotFound(false);
        setLoadError(null);
      },
      (caught) => {
        if (caught instanceof ApiError && caught.status === 404) {
          setNotFound(true);
          return;
        }
        setLoadError("Couldn't load this subscriber's history.");
      },
    );
  }, [id]);
  useEffect(() => reload(), [reload]);

  if (notFound) {
    return (
      <div className="gcpe-subscriber-history">
        <h1>Subscriber history</h1>
        <p>Subscriber not found.</p>
      </div>
    );
  }

  if (loadError && items === null) {
    return (
      <div className="gcpe-subscriber-history">
        <h1>Subscriber history</h1>
        <InlineAlert variant="danger" role="alert" description={loadError} />
      </div>
    );
  }

  return (
    <div className="gcpe-subscriber-history">
      <h1>Subscriber history</h1>
      {loadError && <InlineAlert variant="danger" role="alert" description={loadError} />}
      <p>
        <Link to={`/subscribers/${id}`}>Back to subscriber</Link>
      </p>

      {items === null && <p>Loading…</p>}
      {truncated && <p>{`Showing the most recent ${HISTORY_LIMIT} entries.`}</p>}
      {items !== null && items.length === 0 && <p>No history yet.</p>}
      {items !== null && items.length > 0 && (
        <table aria-label="Subscriber history">
          <thead>
            <tr>
              <th scope="col">When</th>
              <th scope="col">What</th>
              <th scope="col">Who</th>
              <th scope="col">Detail</th>
            </tr>
          </thead>
          <tbody>
            {items.map((h, i) => (
              <tr key={i}>
                <td>{formatWhen(h.at, new Date(), timeZone)}</td>
                <td>{historyLabel(h.action)}</td>
                <td>{actorLabel(h.actor)}</td>
                <td>{h.detail}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

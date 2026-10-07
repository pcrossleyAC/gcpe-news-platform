import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router";
import { apiFetch, ApiError } from "../../api/client";
import { formatWhen } from "../../format/dates";
import { useTenantTimeZone } from "../../format/tenantTimeZone";
import { useDocumentTitle } from "../../shared/useDocumentTitle";
import { actorLabel, historyLabel } from "./labels";
import type { HistoryEntry } from "./types";

/** `/hub/subscribers/:id/history` (legacy SubscriberHistory.aspx): read-only, newest first —
 * apps/nod/src/staff-subscribers/read.ts's listHistory already orders it that way. */
export function HistoryScreen(): React.JSX.Element {
  const { id = "" } = useParams();
  const timeZone = useTenantTimeZone();
  useDocumentTitle("Subscriber history");

  const [items, setItems] = useState<HistoryEntry[] | null>(null);
  const [notFound, setNotFound] = useState(false);

  const reload = useCallback(() => {
    apiFetch<{ items: HistoryEntry[] }>(`/nod/api/subscribers/${id}/history`).then(
      (r) => {
        setItems(r.items);
        setNotFound(false);
      },
      (caught) => {
        if (caught instanceof ApiError && caught.status === 404) setNotFound(true);
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

  return (
    <div className="gcpe-subscriber-history">
      <h1>Subscriber history</h1>
      <p>
        <Link to={`/subscribers/${id}`}>Back to subscriber</Link>
      </p>

      {items === null && <p>Loading…</p>}
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

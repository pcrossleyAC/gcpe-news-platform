import { useCallback, useEffect, useRef, useState } from "react";
import { Button, InlineAlert } from "@bcgov/design-system-react-components";
import { apiFetch } from "../../../api/client";
import { useDocumentTitle } from "../../../shared/useDocumentTitle";
import { messagesOf } from "../../admin/messages";

interface DeadLetter {
  eventId: string;
  subscriber: string;
  type: string;
  aggregateId: string;
  attempts: number;
  lastError: string | null;
  createdAt: string;
  queuedAtBc: string;
}

const RETRY_NOTE = "Queued for delivery again. If it comes back here after the next minute, the receiving app is still refusing it: check it before retrying.";

/** `/hub/calendar/dead-letters` (spec addendum §5.1): the Calendar's events no app accepted within 24 hours. */
export function DeadLettersScreen(): React.JSX.Element {
  useDocumentTitle("Undelivered events");
  const [rows, setRows] = useState<DeadLetter[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [messages, setMessages] = useState<string[]>([]);
  const latest = useRef(0);

  const reload = useCallback((after?: (rows: DeadLetter[]) => void) => {
    const call = ++latest.current;
    apiFetch<DeadLetter[]>("/calendar/api/dead-letters").then(
      (r) => {
        if (call !== latest.current) return;
        setRows(r);
        after?.(r);
      },
      () => call === latest.current && setError("Couldn't load undelivered events."),
    );
  }, []);
  useEffect(() => reload(), [reload]);

  const retry = async (d: DeadLetter) => {
    setMessages([]);
    try {
      await apiFetch("/calendar/api/dead-letters/retry", { method: "POST", body: { eventId: d.eventId, subscriber: d.subscriber } });
      reload((r) => setStatus(r.some((x) => x.eventId === d.eventId && x.subscriber === d.subscriber) ? RETRY_NOTE : "Queued for delivery again."));
    } catch (caught) {
      setMessages(messagesOf(caught));
    }
  };

  if (error) return <InlineAlert variant="danger" role="alert" description={error} />;
  return (
    <div>
      <h1>Undelivered events</h1>
      <p>Events the Calendar couldn&rsquo;t deliver to another app for 24 hours. Retrying sends one once more on the next minute&rsquo;s tick. No event here shows its activity&rsquo;s own text.</p>
      {status && <p role="status">{status}</p>}
      {messages.map((m) => (
        <p role="alert" key={m}>
          {m}
        </p>
      ))}
      {rows === null ? (
        <p>Loading…</p>
      ) : rows.length === 0 ? (
        <p>Nothing is waiting: every event was delivered.</p>
      ) : (
        <table>
          <caption>Undelivered events, newest first</caption>
          <thead>
            <tr>
              <th scope="col">Event</th>
              <th scope="col">About</th>
              <th scope="col">To</th>
              <th scope="col">Attempts</th>
              <th scope="col">Last error</th>
              <th scope="col">Queued</th>
              <th scope="col">
                <span className="gcpe-visually-hidden">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((d) => (
              <tr key={`${d.eventId}:${d.subscriber}`}>
                <td>{d.type}</td>
                <td>{d.aggregateId}</td>
                <td>{d.subscriber}</td>
                <td>{d.attempts}</td>
                <td>{d.lastError ?? ""}</td>
                <td>{d.queuedAtBc}</td>
                <td>
                  <Button variant="secondary" size="small" onPress={() => void retry(d)} aria-label={`Retry ${d.type} for ${d.aggregateId}`}>
                    Retry
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

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

/** apps/calendar/src/dead-letters.ts's DeadLetterList. */
interface DeadLetterList {
  items: DeadLetter[];
  truncated: boolean;
}

const keyOf = (d: DeadLetter) => `${d.eventId}:${d.subscriber}`;

const RETRY_NOTE = "Queued for delivery again. If it comes back here after the next minute, the receiving app is still refusing it: check it before retrying.";

/** `/hub/calendar/dead-letters` (spec addendum §5.1): the Calendar's events no app accepted within 24 hours. */
export function DeadLettersScreen(): React.JSX.Element {
  useDocumentTitle("Undelivered events");
  const [rows, setRows] = useState<DeadLetter[] | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [messages, setMessages] = useState<string[]>([]);
  /** The deliveries whose retry is in flight, by `keyOf`. */
  const [retrying, setRetrying] = useState<ReadonlySet<string>>(new Set());
  const latest = useRef(0);

  const reload = useCallback((after?: (rows: DeadLetter[]) => void) => {
    const call = ++latest.current;
    apiFetch<DeadLetterList>("/calendar/api/dead-letters").then(
      (r) => {
        if (call !== latest.current) return;
        setRows(r.items);
        setTruncated(r.truncated);
        after?.(r.items);
      },
      () => call === latest.current && setError("Couldn't load undelivered events."),
    );
  }, []);
  useEffect(() => reload(), [reload]);

  const retry = async (d: DeadLetter) => {
    const key = keyOf(d);
    setMessages([]);
    setStatus(null);
    setRetrying((s) => new Set(s).add(key));
    try {
      await apiFetch("/calendar/api/dead-letters/retry", { method: "POST", body: { eventId: d.eventId, subscriber: d.subscriber } });
      reload((r) => setStatus(r.some((x) => keyOf(x) === key) ? RETRY_NOTE : "Queued for delivery again."));
    } catch (caught) {
      setMessages(messagesOf(caught));
    } finally {
      setRetrying((s) => {
        const next = new Set(s);
        next.delete(key);
        return next;
      });
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
        <>
          {truncated && <p>Only the 200 most recent are listed.</p>}
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
                <tr key={keyOf(d)}>
                  <td>{d.type}</td>
                  <td>{d.aggregateId}</td>
                  <td>{d.subscriber}</td>
                  <td>{d.attempts}</td>
                  <td>{d.lastError ?? ""}</td>
                  <td>{d.queuedAtBc}</td>
                  <td>
                    <Button variant="secondary" size="small" onPress={() => void retry(d)} isDisabled={retrying.has(keyOf(d))} aria-label={`Retry ${d.type} for ${d.aggregateId} to ${d.subscriber}, queued ${d.queuedAtBc}`}>
                      Retry
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}

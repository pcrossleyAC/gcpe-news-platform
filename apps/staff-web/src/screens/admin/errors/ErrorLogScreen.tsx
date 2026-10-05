import { useCallback, useEffect, useState } from "react";
import { Button, InlineAlert } from "@bcgov/design-system-react-components";
import { apiFetch } from "../../../api/client";
import { useSession } from "../../../session/SessionContext";
import { useTenantTimeZone } from "../../../format/tenantTimeZone";
import { formatWhen } from "../../../format/dates";

export interface ErrorEntry {
  timestamp: string;
  message: string;
  pid: number;
  startedAt: string;
}

/**
 * `/hub/error-log` (task-5-brief.md): `GET /stack/errors?limit=200` (Core.Admin). The ring
 * (apps/stack/src/errors.ts) is append-ordered, oldest first, and `/stack/errors` doesn't
 * reverse it — this screen does, to show newest first as the brief asks.
 */
export function ErrorLogScreen(): React.JSX.Element {
  const session = useSession();
  const timeZone = useTenantTimeZone();
  const isAdmin = session.has("Core.Admin");
  const [entries, setEntries] = useState<ErrorEntry[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const reload = useCallback(() => {
    apiFetch<{ errors: ErrorEntry[] }>("/stack/errors?limit=200").then(
      (res) => setEntries([...res.errors].reverse()),
      () => setLoadError("Couldn't load the error log."),
    );
  }, []);

  // Never fetched for anyone who can't see this page — AppShell already hides the nav item,
  // and a direct deep link must not even issue the request (defense in depth, same reasoning
  // as WebsiteScreen's own role check).
  useEffect(() => {
    if (isAdmin) reload();
  }, [isAdmin, reload]);

  if (!isAdmin) {
    return (
      <div className="gcpe-error-log">
        <h1>Error log</h1>
        <p>You don&rsquo;t have permission to view this page.</p>
      </div>
    );
  }

  return (
    <div className="gcpe-error-log">
      <h1>Error log</h1>
      <p>Entries survive restarts. Values in database error messages are redacted before they&rsquo;re stored.</p>
      <Button onPress={reload}>Refresh</Button>

      {loadError && <InlineAlert variant="danger" role="alert" description={loadError} />}
      {entries === null && !loadError && <p>Loading…</p>}
      {entries?.length === 0 && <p>No errors logged.</p>}
      {entries && entries.length > 0 && (
        <table>
          <caption>Error log, newest first</caption>
          <thead>
            <tr>
              <th scope="col">When</th>
              <th scope="col">Process ID</th>
              <th scope="col">Message</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((e, i) => (
              <tr key={i}>
                <td>{formatWhen(e.timestamp, new Date(), timeZone)}</td>
                <td>{e.pid}</td>
                <td>
                  <pre style={{ whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{e.message}</pre>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

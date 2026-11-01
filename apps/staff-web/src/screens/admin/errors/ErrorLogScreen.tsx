import { useCallback, useEffect, useState } from "react";
import { Button, InlineAlert } from "@bcgov/design-system-react-components";
import { apiFetch } from "../../../api/client";
import { useSession } from "../../../session/SessionContext";
import { useTenantTimeZone } from "../../../format/tenantTimeZone";
import { formatWhen } from "../../../format/dates";
import { TableScroll } from "../../../shared/TableScroll";
import { useDocumentTitle } from "../../../shared/useDocumentTitle";

/** apps/stack/src/errors.ts's ErrorGroup: identical messages folded together. */
export interface ErrorGroup {
  message: string;
  count: number;
  firstAt: string;
  lastAt: string;
  pid: number;
  startedAt: string;
}

/**
 * `/hub/error-log` (task-5-brief.md): `GET /stack/errors?group=1&limit=200` (Core.Admin). Suite
 * review O2.3 (owner 2026-10-31): identical messages come back folded into one group each, newest
 * group first, across everything the log keeps, so one outage repeating a line every few minutes
 * is one row and doesn't push every other error out of view.
 */
export function ErrorLogScreen(): React.JSX.Element {
  const session = useSession();
  const timeZone = useTenantTimeZone();
  useDocumentTitle("Error log");
  const isAdmin = session.has("Core.Admin");
  const [entries, setEntries] = useState<ErrorGroup[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const reload = useCallback(() => {
    apiFetch<{ groups: ErrorGroup[] }>("/stack/errors?group=1&limit=200").then(
      (res) => setEntries(res.groups),
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

  const now = new Date();
  return (
    <div className="gcpe-error-log">
      <h1>Error log</h1>
      <p>Entries survive restarts. Values in database error messages are redacted before they&rsquo;re stored. An error that happened more than once is shown once, with how many times.</p>
      <Button onPress={reload}>Refresh</Button>

      {loadError && <InlineAlert variant="danger" role="alert" description={loadError} />}
      {entries === null && !loadError && <p>Loading…</p>}
      {entries?.length === 0 && <p>No errors logged.</p>}
      {entries && entries.length > 0 && (
        <TableScroll label="Error log">
        <table className="gcpe-table">
          <caption>Error log, newest first</caption>
          <thead>
            <tr>
              <th scope="col">When</th>
              <th scope="col">How often</th>
              <th scope="col">Process ID</th>
              <th scope="col">Message</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((e) => (
              <tr key={`${e.lastAt}:${e.message}`}>
                <td>{formatWhen(e.lastAt, now, timeZone)}</td>
                <td>{e.count === 1 ? "Once" : `${e.count} times, first ${formatWhen(e.firstAt, now, timeZone, { withDate: true })}`}</td>
                <td>{e.pid}</td>
                <td>
                  <pre style={{ whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{e.message}</pre>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        </TableScroll>
      )}
    </div>
  );
}

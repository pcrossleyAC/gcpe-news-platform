import { useCallback, useEffect, useRef, useState } from "react";
import { InlineAlert } from "@bcgov/design-system-react-components";
import { apiFetch } from "../../../api/client";
import { formatWhen } from "../../../format/dates";
import { useTenantTimeZone } from "../../../format/tenantTimeZone";
import { useSession } from "../../../session/SessionContext";
import { Button } from "../../../shared/BusyButton";
import { TableScroll } from "../../../shared/TableScroll";
import { useDocumentTitle } from "../../../shared/useDocumentTitle";
import { messagesOf } from "../messages";

/** packages/events undelivered.ts's UndeliveredUpdate. */
interface Update {
  eventId: string;
  subscriber: string;
  type: string;
  aggregateId: string;
  about: string | null;
  attempts: number;
  lastError: string | null;
  createdAt: string;
}

/** apps/stack/src/undelivered.ts's GET /stack/undelivered. */
interface AppList {
  app: string;
  items: Update[];
  total: number;
  truncated: boolean;
}

type Row = Update & { app: string };

/** The apps by the names staff know them by; an unknown one shows as sent. */
const APP_LABELS: Record<string, string> = {
  nrms: "Releases",
  core: "Core administration",
  distribution: "Email sending",
  "news-api": "News service",
  calendar: "Calendar",
  nod: "Subscribers (News On Demand)",
  "public-site": "Public site",
};
const appLabel = (name: string) => APP_LABELS[name] ?? name;

const EVENT_LABELS: Record<string, string> = {
  "release.published": "Release published",
  "release.updated": "Release changed",
  "release.unpublished": "Release unpublished",
  "release.status_changed": "Release status changed",
  "org.upserted": "Organization changed",
  "org.deactivated": "Organization deactivated",
  "org.succeeded": "Organization handed over",
  "user.upserted": "User changed",
  "sector.upserted": "Sector changed",
  "sector.deactivated": "Sector deactivated",
  "theme.upserted": "Theme changed",
  "theme.deactivated": "Theme deactivated",
  "tag.upserted": "Tag changed",
  "tag.deactivated": "Tag deactivated",
  "service.upserted": "Service changed",
  "service.deactivated": "Service deactivated",
  "media_list.created": "Media list added",
  "media_list.updated": "Media list changed",
  "media_list.deactivated": "Media list deactivated",
  "site.content.changed": "Website content changed",
  "site.rebuild_requested": "Website pages to rebuild",
  "site.settings.published": "Website settings published",
  "government_terms.published": "Government terms published",
  "delivery.bounced": "Email bounce",
  "activity.created": "New activity",
  "activity.updated": "Activity changed",
  "activity.deleted": "Activity deleted",
};
const updateLabel = (u: Update) => {
  const what = EVENT_LABELS[u.type] ?? u.type;
  return u.about ? `${what}: ${u.about}` : what;
};

const ERROR_LENGTH = 120;
const shortError = (e: string | null) => (e === null ? "" : e.length > ERROR_LENGTH ? `${e.slice(0, ERROR_LENGTH)}…` : e);

const keyOf = (r: { app: string; eventId: string; subscriber: string }) => `${r.app}:${r.eventId}:${r.subscriber}`;

const RETRY_NOTE = "Queued for delivery again. If it comes back here after the next minute, the receiving app is still refusing it: have that fixed before retrying again.";

/**
 * `/hub/undelivered-updates` (suite review O1.3, owner 2026-10-31): every app's updates another app
 * didn't accept within 24 hours, with Retry. Core.Admin only. The Calendar's own Undelivered events
 * tab, for its system administrators, stays as it is.
 */
export function UndeliveredUpdatesScreen(): React.JSX.Element {
  const session = useSession();
  const timeZone = useTenantTimeZone();
  useDocumentTitle("Undelivered updates");
  const isAdmin = session.has("Core.Admin");
  const [apps, setApps] = useState<AppList[] | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [messages, setMessages] = useState<string[]>([]);
  /** Rows (keyOf) and apps ("all:<app>") whose retry is in flight. */
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
  const latest = useRef(0);

  const reload = useCallback((after?: (apps: AppList[]) => void) => {
    const call = ++latest.current;
    apiFetch<{ apps: AppList[] }>("/stack/undelivered").then(
      (r) => {
        if (call !== latest.current) return;
        setLoadError(false);
        setApps(r.apps);
        after?.(r.apps);
      },
      () => call === latest.current && setLoadError(true),
    );
  }, []);

  // Never fetched for anyone who can't see this page (as on the Error log).
  useEffect(() => {
    if (isAdmin) reload();
  }, [isAdmin, reload]);

  const withBusy = async (key: string, work: () => Promise<void>) => {
    setMessages([]);
    setStatus(null);
    setBusy((s) => new Set(s).add(key));
    try {
      await work();
    } catch (caught) {
      setMessages(messagesOf(caught));
    } finally {
      setBusy((s) => {
        const next = new Set(s);
        next.delete(key);
        return next;
      });
    }
  };

  const retry = (r: Row) =>
    withBusy(keyOf(r), async () => {
      await apiFetch("/stack/undelivered/retry", { method: "POST", body: { app: r.app, eventId: r.eventId, subscriber: r.subscriber } });
      reload((now) => setStatus(now.some((a) => a.app === r.app && a.items.some((x) => keyOf({ ...x, app: a.app }) === keyOf(r))) ? RETRY_NOTE : "Queued for delivery again."));
    });

  const retryAll = (app: string) =>
    withBusy(`all:${app}`, async () => {
      const { retried } = await apiFetch<{ retried: number }>("/stack/undelivered/retry-all", { method: "POST", body: { app } });
      reload(() => setStatus(`${retried} ${retried === 1 ? "update" : "updates"} queued for delivery again. Any that come back here after the next minute are still being refused.`));
    });

  if (!isAdmin) {
    return (
      <div>
        <h1>Undelivered updates</h1>
        <p>You don&rsquo;t have permission to view this page.</p>
      </div>
    );
  }

  const rows: Row[] = (apps ?? []).flatMap((a) => a.items.map((u) => ({ ...u, app: a.app }))).sort((x, y) => y.createdAt.localeCompare(x.createdAt));
  const now = new Date();

  return (
    <div>
      <h1>Undelivered updates</h1>
      <p>
        Updates one part of the system sent to another that weren&rsquo;t accepted within 24 hours, such as a published release that never reached subscribers. Retry sends one again within the next
        minute. No update here shows its full text.
      </p>
      <Button variant="secondary" onPress={() => reload()}>
        Refresh
      </Button>
      {loadError && <InlineAlert variant="danger" role="alert" description="Couldn't load undelivered updates." />}
      {status && <p role="status">{status}</p>}
      {messages.map((m) => (
        <p role="alert" key={m}>
          {m}
        </p>
      ))}
      {apps === null ? (
        !loadError && <p>Loading…</p>
      ) : rows.length === 0 ? (
        <p>Nothing is waiting: every update was delivered.</p>
      ) : (
        <>
          {apps
            .filter((a) => a.truncated)
            .map((a) => (
              <p key={`cut:${a.app}`}>
                {appLabel(a.app)} has {a.total} undelivered updates: only the 200 most recent are listed.
              </p>
            ))}
          {apps.some((a) => a.items.length > 1) && (
            <div className="gcpe-button-row">
              {apps
                .filter((a) => a.items.length > 1)
                .map((a) => (
                  <Button key={`all:${a.app}`} variant="secondary" onPress={() => void retryAll(a.app)} isPending={busy.has(`all:${a.app}`)} pendingLabel="Retrying…">
                    {`Retry all ${a.total} from ${appLabel(a.app)}`}
                  </Button>
                ))}
            </div>
          )}
          <TableScroll label="Undelivered updates">
            <table className="gcpe-table">
              <caption>Undelivered updates, newest first</caption>
              <thead>
                <tr>
                  <th scope="col">When</th>
                  <th scope="col">From</th>
                  <th scope="col">Update</th>
                  <th scope="col">Not accepted by</th>
                  <th scope="col">Last error</th>
                  <th scope="col">
                    <span className="gcpe-visually-hidden">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={keyOf(r)}>
                    <td>{formatWhen(r.createdAt, now, timeZone)}</td>
                    <td>{appLabel(r.app)}</td>
                    <td>{updateLabel(r)}</td>
                    <td>{appLabel(r.subscriber)}</td>
                    <td>{shortError(r.lastError)}</td>
                    <td>
                      <Button
                        variant="secondary"
                        size="small"
                        onPress={() => void retry(r)}
                        isPending={busy.has(keyOf(r))}
                        pendingLabel="Retrying…"
                        aria-label={`Retry ${updateLabel(r)} to ${appLabel(r.subscriber)}, sent ${formatWhen(r.createdAt, now, timeZone)}`}
                      >
                        Retry
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableScroll>
        </>
      )}
    </div>
  );
}

import { useCallback, useEffect, useRef, useState } from "react";
import { AlertDialog, InlineAlert, Modal } from "@bcgov/design-system-react-components";
import { apiFetch } from "../../../api/client";
import { formatWhen } from "../../../format/dates";
import { useTenantTimeZone } from "../../../format/tenantTimeZone";
import { useSession } from "../../../session/SessionContext";
import { afterDialogsClose } from "../../../shared/afterDialogsClose";
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
  /** A newer update for the same record, to the same app, replaced it: it is never resent. */
  replaced: boolean;
  /** A newer update for the same record already reached that app, which would ignore this one (fix round 2, M4). */
  overtaken: boolean;
}

/** apps/stack/src/undelivered.ts's GET /stack/undelivered, one entry per app. */
interface AppList {
  app: string;
  items: Update[];
  total: number;
  /** How many of `total` are replaced, and overtaken. */
  replaced: number;
  overtaken: number;
  truncated: boolean;
}

/** apps/core/src/services/outbox-dismissals.ts's Dismissal. */
interface Dismissal {
  app: string;
  eventId: string;
  subscriber: string;
  type: string;
  about: string | null;
  createdAt: string;
  dismissedAt: string;
  dismissedBy: string;
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
const updateLabel = (u: { type: string; about: string | null }) => {
  const what = EVENT_LABELS[u.type] ?? u.type;
  return u.about ? `${what}: ${u.about}` : what;
};

const ERROR_LENGTH = 120;
const shortError = (e: string | null) => (e === null ? "" : e.length > ERROR_LENGTH ? `${e.slice(0, ERROR_LENGTH)}…` : e);

const keyOf = (r: { app: string; eventId: string; subscriber: string }) => `${r.app}:${r.eventId}:${r.subscriber}`;

const RETRY_NOTE = "Queued for delivery again. If it comes back here after the next minute, the receiving app is still refusing it: have that fixed before retrying again.";

type Confirming = { kind: "retry-all"; app: string; resend: number; replaced: number; overtaken: number } | { kind: "dismiss-all"; count: number };

/** What to say on an overtaken row: resending is pointless, so how to get the change through instead. */
const overtakenNote = (u: { type: string }) =>
  u.type.startsWith("release.")
    ? "A later change got there first, so it can't be sent again. To send it, publish the release again from Releases."
    : "A later change got there first, so it can't be sent again. To send it, make the change again where it was made.";

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * `/hub/undelivered-updates` (suite review O1.3, owner 2026-10-31): every app's updates another app
 * didn't accept within 24 hours, with Retry and Dismiss. Core.Admin only. The Calendar's own
 * Undelivered events tab, for its system administrators, stays as it is.
 *
 * Fix round 1 (controller rulings 2026-11-01): an update a newer one for the same record replaced is
 * shown as replaced and never resent (I1); Retry all and Dismiss all ask first (I1, M1); Dismiss
 * marks one handled without sending it, and recent dismissals are listed with who did it (M1). The
 * status line is always mounted, and takes focus once a row it reports on has gone (N2).
 */
export function UndeliveredUpdatesScreen(): React.JSX.Element {
  const session = useSession();
  const timeZone = useTenantTimeZone();
  useDocumentTitle("Undelivered updates");
  const isAdmin = session.has("Core.Admin");
  const [apps, setApps] = useState<AppList[] | null>(null);
  const [dismissed, setDismissed] = useState<Dismissal[]>([]);
  const [loadError, setLoadError] = useState(false);
  const [status, setStatus] = useState("");
  const [messages, setMessages] = useState<string[]>([]);
  const [confirming, setConfirming] = useState<Confirming | null>(null);
  /** Rows (keyOf), apps ("all:<app>") and "dismiss-all" whose action is in flight. */
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
  const latest = useRef(0);
  const statusRef = useRef<HTMLParagraphElement>(null);

  const reload = useCallback((after?: (apps: AppList[]) => void) => {
    const call = ++latest.current;
    apiFetch<{ apps: AppList[]; dismissed?: Dismissal[] }>("/stack/undelivered").then(
      (r) => {
        if (call !== latest.current) return;
        setLoadError(false);
        setApps(r.apps);
        setDismissed(r.dismissed ?? []);
        after?.(r.apps);
      },
      () => call === latest.current && setLoadError(true),
    );
  }, []);

  // Never fetched for anyone who can't see this page (as on the Error log).
  useEffect(() => {
    if (isAdmin) reload();
  }, [isAdmin, reload]);

  /** Says what happened and moves focus to it: the button pressed may have gone with its row. */
  const report = (text: string) => {
    setStatus(text);
    requestAnimationFrame(() => statusRef.current?.focus());
  };

  const withBusy = async (key: string, work: () => Promise<void>) => {
    setMessages([]);
    setStatus("");
    setBusy((s) => new Set(s).add(key));
    try {
      await work();
    } catch (caught) {
      const shown = messagesOf(caught);
      afterDialogsClose(() => setMessages(shown));
      reload();
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
      reload((now) => report(now.some((a) => a.app === r.app && a.items.some((x) => keyOf({ ...x, app: a.app }) === keyOf(r))) ? RETRY_NOTE : "Queued for delivery again."));
    });

  const dismiss = (r: Row) =>
    withBusy(`dismiss:${keyOf(r)}`, async () => {
      await apiFetch("/stack/undelivered/dismiss", { method: "POST", body: { app: r.app, eventId: r.eventId, subscriber: r.subscriber } });
      reload(() => report("Dismissed: it won't be sent."));
    });

  const retryAll = (app: string) =>
    withBusy(`all:${app}`, async () => {
      const { retried, busy: waiting = 0 } = await apiFetch<{ retried: number; replaced: number; overtaken?: number; busy?: number }>("/stack/undelivered/retry-all", { method: "POST", body: { app } });
      setConfirming(null);
      // Fix round 4, N10: ones whose newer version was being sent right then were left for later.
      const later = waiting > 0 ? ` ${waiting} ${waiting === 1 ? "wasn't sent because its newer version is being sent right now: try it" : "weren't sent because their newer versions are being sent right now: try them"} again in a minute.` : "";
      reload(() => afterDialogsClose(() => report(`${plural(retried, "update", "updates")} queued for delivery again. Any that come back here after the next minute are still being refused.${later}`)));
    }).finally(() => setConfirming(null));

  const dismissAll = () =>
    withBusy("dismiss-all", async () => {
      const { dismissed: n } = await apiFetch<{ dismissed: number }>("/stack/undelivered/dismiss-all", { method: "POST", body: {} });
      setConfirming(null);
      reload(() => afterDialogsClose(() => report(`${plural(n, "update", "updates")} dismissed: ${n === 1 ? "it won't" : "they won't"} be sent.`)));
    }).finally(() => setConfirming(null));

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
  const allTotal = (apps ?? []).reduce((n, a) => n + a.total, 0);
  const resendable = (a: AppList) => a.total - a.replaced - a.overtaken;
  const retryable = (apps ?? []).filter((a) => a.total > 1 && resendable(a) > 0);
  const pending = confirming?.kind === "retry-all" ? busy.has(`all:${confirming.app}`) : busy.has("dismiss-all");

  return (
    <div>
      <h1>Undelivered updates</h1>
      <p>
        Updates one part of the system sent to another that weren&rsquo;t accepted within 24 hours, such as a published release that never reached subscribers. Retry sends one again within the next
        minute: a Release published update then emails its subscribers. Dismiss marks one as handled without sending it. No update here shows its full text.
      </p>
      <Button variant="secondary" onPress={() => reload()}>
        Refresh
      </Button>
      {loadError && <InlineAlert variant="danger" role="alert" description="Couldn't load undelivered updates." />}
      {/* Always mounted, so what it says is announced (fix round 1, N2). */}
      <p role="status" ref={statusRef} tabIndex={-1}>
        {status}
      </p>
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
          <div className="gcpe-button-row">
            {retryable.map((a) => (
              <Button key={`all:${a.app}`} variant="secondary" onPress={() => setConfirming({ kind: "retry-all", app: a.app, resend: resendable(a), replaced: a.replaced, overtaken: a.overtaken })}>
                {`Retry all ${resendable(a)} from ${appLabel(a.app)}`}
              </Button>
            ))}
            {allTotal > 1 && (
              <Button variant="secondary" onPress={() => setConfirming({ kind: "dismiss-all", count: allTotal })}>
                {`Dismiss all ${allTotal}`}
              </Button>
            )}
          </div>
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
                {rows.map((r) => {
                  const what = `${updateLabel(r)} to ${appLabel(r.subscriber)}, sent ${formatWhen(r.createdAt, now, timeZone)}`;
                  return (
                    <tr key={keyOf(r)}>
                      <td>{formatWhen(r.createdAt, now, timeZone)}</td>
                      <td>{appLabel(r.app)}</td>
                      <td>{updateLabel(r)}</td>
                      <td>{appLabel(r.subscriber)}</td>
                      <td>{shortError(r.lastError)}</td>
                      <td>
                        <div className="gcpe-button-row">
                          {r.replaced ? (
                            <span>Replaced by a newer update: not sent again</span>
                          ) : r.overtaken ? (
                            <span>{overtakenNote(r)}</span>
                          ) : (
                            <Button variant="secondary" size="small" onPress={() => void retry(r)} isPending={busy.has(keyOf(r))} pendingLabel="Retrying…" aria-label={`Retry ${what}`}>
                              Retry
                            </Button>
                          )}
                          <Button variant="tertiary" size="small" onPress={() => void dismiss(r)} isPending={busy.has(`dismiss:${keyOf(r)}`)} pendingLabel="Dismissing…" aria-label={`Dismiss ${what}`}>
                            Dismiss
                          </Button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </TableScroll>
        </>
      )}
      {dismissed.length > 0 && (
        <>
          <h2>Dismissed</h2>
          <TableScroll label="Dismissed updates">
            <table className="gcpe-table">
              <caption>Dismissed updates, most recent first</caption>
              <thead>
                <tr>
                  <th scope="col">Dismissed</th>
                  <th scope="col">By</th>
                  <th scope="col">From</th>
                  <th scope="col">Update</th>
                  <th scope="col">Not accepted by</th>
                </tr>
              </thead>
              <tbody>
                {dismissed.map((d) => (
                  <tr key={keyOf(d)}>
                    <td>{formatWhen(d.dismissedAt, now, timeZone)}</td>
                    <td>{d.dismissedBy}</td>
                    <td>{appLabel(d.app)}</td>
                    <td>{updateLabel(d)}</td>
                    <td>{appLabel(d.subscriber)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableScroll>
        </>
      )}
      <Modal isOpen={confirming !== null} onOpenChange={(open) => { if (!open && !pending) setConfirming(null); }} isDismissable>
        {confirming?.kind === "retry-all" ? (
          <AlertDialog
            role="alertdialog"
            title={`Resend ${plural(confirming.resend, "update", "updates")} from ${appLabel(confirming.app)}?`}
            buttons={
              <>
                <Button variant="secondary" isPending={pending} onPress={() => setConfirming(null)}>
                  Cancel
                </Button>
                <Button isPending={pending} pendingLabel="Resending…" onPress={() => void retryAll(confirming.app)}>
                  Resend
                </Button>
              </>
            }
          >
            <p>They&rsquo;re sent again within the next minute, oldest first. Check that the app that refused them is working first.</p>
            {confirming.replaced > 0 && <p>{`${plural(confirming.replaced, "replaced by a newer update isn't", "replaced by a newer update aren't")} sent.`}</p>}
            {confirming.overtaken > 0 && <p>{`${confirming.overtaken} can't be sent again because a later change got there first.`}</p>}
            {confirming.app === "nrms" && <p>A Release published update emails its subscribers when it&rsquo;s sent.</p>}
          </AlertDialog>
        ) : confirming?.kind === "dismiss-all" ? (
          <AlertDialog
            role="alertdialog"
            variant="warning"
            title={`Dismiss all ${confirming.count} undelivered updates?`}
            buttons={
              <>
                <Button variant="secondary" isPending={pending} onPress={() => setConfirming(null)}>
                  Cancel
                </Button>
                <Button danger isPending={pending} pendingLabel="Dismissing…" onPress={() => void dismissAll()}>
                  Dismiss all
                </Button>
              </>
            }
          >
            <p>None of them will be sent. Dismiss them only once you&rsquo;re sure they don&rsquo;t need to be, for example because the change was made again by hand.</p>
          </AlertDialog>
        ) : null}
      </Modal>
    </div>
  );
}

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { Link, useLocation, useSearchParams } from "react-router";
import { AlertDialog, DialogTrigger, Form, InlineAlert, Modal, TextField } from "@bcgov/design-system-react-components";
import { apiFetch, ApiError } from "../../api/client";
import { formatWhen } from "../../format/dates";
import { useTenantTimeZone } from "../../format/tenantTimeZone";
import { useSession } from "../../session/SessionContext";
import { Button } from "../../shared/BusyButton";
import { TableScroll } from "../../shared/TableScroll";
import { useDocumentTitle } from "../../shared/useDocumentTitle";
import { useSearchShortcut } from "../../shared/shortcuts";
import { Pagination } from "../releases/Pagination";
import { canEditSubscribers } from "./access";
import { DELETE_REASON_REQUIRED, DeleteReasonField, type DeleteReason } from "./DeleteReason";
import { STATUS_FILTER_OPTIONS, STATUS_LABELS, timingLabel } from "./labels";
import type { BulkAction, BulkResult, BulkSkipReason, StatusFilter, SubscriberPage } from "./types";
import type { BackToResults, SubscriberLinkState, SubscribersSearchState } from "./backToResults";

const BULK_COPY: Record<BulkAction, { verb: string; title: (n: number) => string; body: string; variant: "warning" | "destructive" }> = {
  activate: {
    verb: "activate",
    title: (n) => `Activate ${n} ${n === 1 ? "subscriber" : "subscribers"}?`,
    body: "Only disabled subscribers are activated; the rest are skipped. A bounce-disabled subscriber's bounce count starts again.",
    variant: "warning",
  },
  deactivate: {
    verb: "deactivate",
    title: (n) => `Deactivate ${n} ${n === 1 ? "subscriber" : "subscribers"}?`,
    body: "They receive nothing until activated again. Their lists, including media lists, are kept.",
    variant: "warning",
  },
  delete: {
    verb: "delete",
    title: (n) => `Delete ${n} ${n === 1 ? "subscriber" : "subscribers"}?`,
    body: "They stop receiving email and are removed from every media list. Only they can subscribe again.",
    variant: "destructive",
  },
};

/** The search route's own ceiling (apps/nod/src/http/staff-subscriber-routes.ts). */
const MAX_PAGE = 100_000;

/** apps/nod/src/staff-subscribers/actions.ts's BulkSkipReason, "error" included — an
 * unexpected failure on that one row, worth retrying. */
const SKIP_TEXT: Record<BulkSkipReason, string> = {
  unchanged: "already in that state",
  status: "not allowed from their status",
  "not-found": "no longer exist",
  error: "couldn't change – try again",
};

function statusFrom(raw: string | null): StatusFilter {
  return STATUS_FILTER_OPTIONS.find((o) => o.value === raw)?.value ?? "all";
}

function pageFrom(raw: string | null): number {
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 && n <= MAX_PAGE ? n : 1;
}

export function describeBulk(r: BulkResult): string {
  const parts = [`${r.changed} changed.`];
  if (r.skipped.length) {
    const counts = Object.entries(SKIP_TEXT)
      .map(([reason, text]) => [r.skipped.filter((s) => s.reason === reason).length, text] as const)
      .filter(([n]) => n > 0)
      .map(([n, text]) => (r.skipped.length === n ? text : `${n} ${text}`));
    parts.push(`${r.skipped.length} skipped: ${counts.join(", ")}.`);
  }
  return parts.join(" ");
}

/** `/hub/subscribers`: find subscribers by email substring and status (legacy
 * ManageSubscribers). The search term is a POST body field, never a URL/query-string value —
 * it's usually an email address, and a GET's query string is recorded by every reverse proxy
 * and browser history; status and page are plain `useSearchParams` state since neither is
 * sensitive. Editors select rows on the current page for a bulk action, always behind a
 * confirm dialog. Selection never spans pages and clears on every reload. */
export function SubscribersScreen(): React.JSX.Element {
  const session = useSession();
  useDocumentTitle("Subscribers");
  useSearchShortcut("subscribers-q");
  const timeZone = useTenantTimeZone();
  const canEdit = canEditSubscribers(session);
  const [params, setParams] = useSearchParams();
  // A hand-edited or stale URL falls back to the defaults rather than being sent as a bad request.
  const status = statusFrom(params.get("status"));
  const page = pageFrom(params.get("page"));

  // The search term rides in this history entry's state (never the URL): Back from a subscriber,
  // or "Back to results" there, brings the same results back without typing the address again.
  const location = useLocation();
  const remembered = (location.state as SubscribersSearchState | null)?.subscribersQ ?? "";
  const [q, setQ] = useState(remembered);
  const [qInput, setQInput] = useState(remembered);
  // Only a history entry for a different search resets the box (Back to an earlier one): paging
  // keeps the same term, and must not wipe what's typed but not yet searched.
  useEffect(() => {
    if (remembered === q) return;
    setQ(remembered);
    setQInput(remembered);
  }, [location.key]); // eslint-disable-line react-hooks/exhaustive-deps
  const [statusInput, setStatusInput] = useState<StatusFilter>(status);
  const [result, setResult] = useState<SubscriberPage | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [pendingAction, setPendingAction] = useState<BulkAction | null>(null);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<string | null>(null);
  const [bulkError, setBulkError] = useState<string | null>(null);
  // N2: Delete selected asks why, with the record's own choice (DeleteReason.tsx), for all of them.
  const [deleteWhy, setDeleteWhy] = useState<DeleteReason | null>(null);
  const [deleteWhyError, setDeleteWhyError] = useState<string | null>(null);

  // Only the latest search may land: an earlier, slower response arriving after it would
  // otherwise replace the results for what the staff member is now looking at.
  const latestSearch = useRef(0);
  const reload = useCallback(() => {
    const body: { q?: string; status?: StatusFilter; page?: number } = {};
    if (q) body.q = q;
    if (status !== "all") body.status = status;
    if (page !== 1) body.page = page;
    const seq = ++latestSearch.current;
    apiFetch<SubscriberPage>("/nod/api/subscribers/search", { method: "POST", body }).then(
      (r) => {
        if (seq !== latestSearch.current) return;
        setResult(r);
        setSelected([]);
        setLoadError(null);
      },
      () => {
        if (seq === latestSearch.current) setLoadError("Couldn't load subscribers.");
      },
    );
  }, [q, status, page]);
  useEffect(() => reload(), [reload]);

  const onSearch = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setOutcome(null);
    const typed = qInput.trim();
    setQ(typed);
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (statusInput === "all") next.delete("status");
        else next.set("status", statusInput);
        next.delete("page");
        return next;
      },
      { state: { subscribersQ: typed } satisfies SubscribersSearchState },
    );
  };
  const onPage = (next: number) =>
    setParams(
      (prev) => {
        const p = new URLSearchParams(prev);
        p.set("page", String(next));
        return p;
      },
      { state: { subscribersQ: q } satisfies SubscribersSearchState },
    );
  // Where a subscriber's "Back to results" returns to: these results, search term included.
  const backTo: BackToResults = { path: `${location.pathname}${location.search}`, state: { subscribersQ: q } };

  const runBulk = async (action: BulkAction) => {
    if (action === "delete" && !deleteWhy) return setDeleteWhyError(DELETE_REASON_REQUIRED);
    setBusy(true);
    setBulkError(null);
    try {
      const body = action === "delete" ? { action, ids: selected, askedToStop: deleteWhy === "asked" } : { action, ids: selected };
      const r = await apiFetch<BulkResult>("/nod/api/subscribers/bulk", { method: "POST", body });
      setOutcome(describeBulk(r));
      setPendingAction(null);
      reload();
    } catch (caught) {
      setBulkError(caught instanceof ApiError ? caught.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  };

  const items = result?.items ?? [];
  const allSelected = items.length > 0 && selected.length === items.length;
  const toggle = (id: string) => setSelected((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));

  return (
    <div className="gcpe-subscribers__search">
      <h1>Subscribers</h1>
      <Form onSubmit={onSearch} aria-label="Search subscribers" className="gcpe-field-row">
        <TextField id="subscribers-q" label="Email contains" name="q" value={qInput} onChange={setQInput} />
        <div className="gcpe-field">
          <label htmlFor="subscribers-status">Status</label>
          <select id="subscribers-status" value={statusInput} onChange={(e) => setStatusInput(e.target.value as StatusFilter)}>
            {STATUS_FILTER_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
        <Button type="submit">Search</Button>
      </Form>

      {loadError && <InlineAlert variant="danger" role="alert" description={loadError} />}
      {outcome && <p role="status">{outcome}</p>}

      {canEdit && selected.length > 0 && (
        <div className="gcpe-subscribers__bulk">
          {(["activate", "deactivate", "delete"] as const).map((a) => (
            <DialogTrigger
              key={a}
              isOpen={pendingAction === a}
              onOpenChange={(open) => {
                if (open) {
                  setBulkError(null);
                  setDeleteWhy(null);
                  setDeleteWhyError(null);
                  setPendingAction(a);
                } else {
                  setPendingAction(null);
                }
              }}
            >
              <Button variant="secondary" danger={a === "delete"}>
                {`${a[0]!.toUpperCase()}${a.slice(1)} selected (${selected.length})`}
              </Button>
              <Modal isDismissable>
                <AlertDialog
                  role="alertdialog"
                  variant={BULK_COPY[a].variant}
                  title={BULK_COPY[a].title(selected.length)}
                  buttons={
                    <>
                      <Button onPress={() => setPendingAction(null)} isPending={busy}>
                        Cancel
                      </Button>
                      <Button danger={a === "delete"} onPress={() => void runBulk(a)} isPending={busy}>
                        {`Confirm ${BULK_COPY[a].verb}`}
                      </Button>
                    </>
                  }
                >
                  <p>{BULK_COPY[a].body}</p>
                  {a === "delete" && (
                    <DeleteReasonField
                      value={deleteWhy}
                      error={deleteWhyError}
                      onChange={(v) => {
                        setDeleteWhy(v);
                        setDeleteWhyError(null);
                      }}
                    />
                  )}
                  {bulkError && <InlineAlert variant="danger" role="alert" description={bulkError} />}
                </AlertDialog>
              </Modal>
            </DialogTrigger>
          ))}
        </div>
      )}

      {result && items.length === 0 && <p>No subscribers match.</p>}
      {items.length > 0 && (
        <TableScroll label="Subscribers">
        <table aria-label="Subscribers" className="gcpe-table gcpe-table--reflow">
          <thead>
            <tr>
              {canEdit && (
                <th scope="col" className="gcpe-table__select">
                  <input
                    type="checkbox"
                    aria-label="Select all on this page"
                    checked={allSelected}
                    onChange={() => setSelected(allSelected ? [] : items.map((i) => i.id))}
                  />
                </th>
              )}
              <th scope="col">Email</th>
              <th scope="col">Status</th>
              <th scope="col">Timing</th>
              <th scope="col">Registered</th>
            </tr>
          </thead>
          <tbody>
            {items.map((s) => (
              <tr key={s.id}>
                {canEdit && (
                  <td className="gcpe-table__select">
                    <input type="checkbox" aria-label={`Select ${s.email}`} checked={selected.includes(s.id)} onChange={() => toggle(s.id)} />
                  </td>
                )}
                <td className="gcpe-table__primary">
                  <Link to={`/subscribers/${s.id}`} state={{ backTo } satisfies SubscriberLinkState}>
                    {s.email}
                  </Link>
                </td>
                <td data-label="Status">
                  {STATUS_LABELS[s.status]}
                  {s.needsAttention ? " (needs attention)" : ""}
                </td>
                <td data-label="Timing">{timingLabel(s)}</td>
                <td data-label="Registered">{formatWhen(s.createdAt, new Date(), timeZone)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        </TableScroll>
      )}
      {result && <Pagination page={result.page} pageSize={result.pageSize} total={result.total} onPageChange={onPage} />}
    </div>
  );
}

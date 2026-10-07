import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Link, useSearchParams } from "react-router";
import { AlertDialog, Button, DialogTrigger, Form, InlineAlert, Modal, TextField } from "@bcgov/design-system-react-components";
import { apiFetch, ApiError } from "../../api/client";
import { formatWhen } from "../../format/dates";
import { useTenantTimeZone } from "../../format/tenantTimeZone";
import { useSession } from "../../session/SessionContext";
import { useDocumentTitle } from "../../shared/useDocumentTitle";
import { Pagination } from "../releases/Pagination";
import { canEditSubscribers } from "./access";
import { STATUS_FILTER_OPTIONS, STATUS_LABELS, timingLabel } from "./labels";
import type { BulkAction, BulkResult, BulkSkipReason, StatusFilter, SubscriberPage } from "./types";

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

/** apps/nod/src/staff-subscribers/actions.ts's BulkSkipReason, "error" included — an
 * unexpected failure on that one row, worth retrying. */
const SKIP_TEXT: Record<BulkSkipReason, string> = {
  unchanged: "already in that state",
  status: "not allowed from their status",
  "not-found": "no longer exist",
  error: "Couldn't change – try again",
};

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
  const timeZone = useTenantTimeZone();
  const canEdit = canEditSubscribers(session);
  const [params, setParams] = useSearchParams();
  const status = (params.get("status") ?? "all") as StatusFilter;
  const page = Number(params.get("page") ?? "1") || 1;

  const [q, setQ] = useState("");
  const [qInput, setQInput] = useState("");
  const [statusInput, setStatusInput] = useState<StatusFilter>(status);
  const [result, setResult] = useState<SubscriberPage | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [pendingAction, setPendingAction] = useState<BulkAction | null>(null);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<string | null>(null);
  const [bulkError, setBulkError] = useState<string | null>(null);

  const reload = useCallback(() => {
    const body: { q?: string; status?: StatusFilter; page?: number } = {};
    if (q) body.q = q;
    if (status !== "all") body.status = status;
    if (page !== 1) body.page = page;
    apiFetch<SubscriberPage>("/nod/api/subscribers/search", { method: "POST", body }).then(
      (r) => {
        setResult(r);
        setSelected([]);
        setLoadError(null);
      },
      () => setLoadError("Couldn't load subscribers."),
    );
  }, [q, status, page]);
  useEffect(() => reload(), [reload]);

  const onSearch = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setOutcome(null);
    setQ(qInput.trim());
    setParams((prev) => {
      const next = new URLSearchParams(prev);
      if (statusInput === "all") next.delete("status");
      else next.set("status", statusInput);
      next.delete("page");
      return next;
    });
  };
  const onPage = (next: number) =>
    setParams((prev) => {
      const p = new URLSearchParams(prev);
      p.set("page", String(next));
      return p;
    });

  const runBulk = async (action: BulkAction) => {
    setBusy(true);
    setBulkError(null);
    try {
      const r = await apiFetch<BulkResult>("/nod/api/subscribers/bulk", { method: "POST", body: { action, ids: selected } });
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
      <Form onSubmit={onSearch} aria-label="Search subscribers">
        <TextField label="Email contains" name="q" value={qInput} onChange={setQInput} />
        <label htmlFor="subscribers-status">Status</label>
        <select id="subscribers-status" value={statusInput} onChange={(e) => setStatusInput(e.target.value as StatusFilter)}>
          {STATUS_FILTER_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
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
                      <Button onPress={() => setPendingAction(null)} isDisabled={busy}>
                        Cancel
                      </Button>
                      <Button danger={a === "delete"} onPress={() => void runBulk(a)} isDisabled={busy}>
                        {`Confirm ${BULK_COPY[a].verb}`}
                      </Button>
                    </>
                  }
                >
                  <p>{BULK_COPY[a].body}</p>
                  {bulkError && <InlineAlert variant="danger" role="alert" description={bulkError} />}
                </AlertDialog>
              </Modal>
            </DialogTrigger>
          ))}
        </div>
      )}

      {result && items.length === 0 && <p>No subscribers match.</p>}
      {items.length > 0 && (
        <table aria-label="Subscribers">
          <thead>
            <tr>
              {canEdit && (
                <th scope="col">
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
                  <td>
                    <input type="checkbox" aria-label={`Select ${s.email}`} checked={selected.includes(s.id)} onChange={() => toggle(s.id)} />
                  </td>
                )}
                <td>
                  <Link to={`/subscribers/${s.id}`}>{s.email}</Link>
                </td>
                <td>
                  {STATUS_LABELS[s.status]}
                  {s.needsAttention ? " (needs attention)" : ""}
                </td>
                <td>{timingLabel(s)}</td>
                <td>{formatWhen(s.createdAt, new Date(), timeZone)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {result && <Pagination page={result.page} pageSize={result.pageSize} total={result.total} onPageChange={onPage} />}
    </div>
  );
}

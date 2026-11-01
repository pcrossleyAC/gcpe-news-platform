import { useEffect, useState } from "react";
import { useSearchParams } from "react-router";
import { Button, InlineAlert } from "@bcgov/design-system-react-components";
import { apiFetch } from "../../../api/client";
import { formatWhen } from "../../../format/dates";
import { useTenantTimeZone } from "../../../format/tenantTimeZone";
import { useSession } from "../../../session/SessionContext";
import { TableScroll } from "../../../shared/TableScroll";
import { useDocumentTitle } from "../../../shared/useDocumentTitle";
import { Pagination } from "../../releases/Pagination";
import { describeEntry, type AuditPage } from "./describe";

export const ADMIN_HISTORY_PAGE_SIZE = 50;

/** The "What" choices: each is a kind Core filters by (apps/core/src/services/audit.ts, AUDIT_KINDS). */
export const KIND_OPTIONS = [
  { value: "", label: "All changes" },
  { value: "users", label: "Users" },
  { value: "calendar", label: "Calendar access" },
  { value: "organizations", label: "Organizations" },
  { value: "terms", label: "Sectors, themes and tags" },
  { value: "cabinet", label: "Cabinet change" },
] as const;

const DATE = /^\d{4}-\d{2}-\d{2}$/;

interface Filters {
  who: string;
  kind: string;
  from: string;
  to: string;
}

const capitalised = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * `/hub/admin-history` (suite review O3): every change made in Core's admin screens (Users, Calendar
 * access, Organizations, Sectors, themes and tags, Cabinet change), newest first, filtered by who
 * made it, what kind of change and BC dates, 50 to a page. Core.Admin only. The filters and page
 * live in the address, so Back and a shared link keep them.
 */
export function AdminHistoryScreen(): React.JSX.Element {
  const session = useSession();
  const timeZone = useTenantTimeZone();
  useDocumentTitle("Admin history");
  const isAdmin = session.has("Core.Admin");
  const [params, setParams] = useSearchParams();
  const applied: Filters = { who: params.get("who") ?? "", kind: params.get("kind") ?? "", from: params.get("from") ?? "", to: params.get("to") ?? "" };
  const page = Math.max(1, Number(params.get("page")) || 1);
  const [form, setForm] = useState<Filters>(applied);
  const [formError, setFormError] = useState<string | null>(null);
  const [result, setResult] = useState<{ search: string; page: AuditPage } | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [orgNames, setOrgNames] = useState<ReadonlyMap<string, string>>(() => new Map());

  const query = new URLSearchParams();
  if (applied.who.trim()) query.set("who", applied.who.trim());
  if (KIND_OPTIONS.some((o) => o.value && o.value === applied.kind)) query.set("kind", applied.kind);
  if (DATE.test(applied.from)) query.set("from", applied.from);
  if (DATE.test(applied.to)) query.set("to", applied.to);
  query.set("page", String(page));
  query.set("pageSize", String(ADMIN_HISTORY_PAGE_SIZE));
  const search = query.toString();

  // Never fetched for anyone who can't see this page (a direct link), as on Users and Error log.
  useEffect(() => {
    if (!isAdmin) return;
    let active = true;
    setLoadError(false);
    apiFetch<AuditPage>(`/core/api/audit?${search}`).then(
      (p) => active && setResult({ search, page: p }),
      () => active && setLoadError(true),
    );
    return () => {
      active = false;
    };
  }, [isAdmin, search]);

  // Ministry names for Calendar access entries; without them, the entries show the ministry's key.
  useEffect(() => {
    if (!isAdmin) return;
    apiFetch<{ key: string; displayName: string }[]>("/core/api/organizations").then(
      (orgs) => Array.isArray(orgs) && setOrgNames(new Map(orgs.map((o) => [o.key, o.displayName]))),
      () => undefined,
    );
  }, [isAdmin]);

  if (!isAdmin) {
    return (
      <div className="gcpe-admin-history">
        <h1>Admin history</h1>
        <p>You don&rsquo;t have permission to view this page.</p>
      </div>
    );
  }

  const set = <K extends keyof Filters>(k: K, v: Filters[K]) => setForm((f) => ({ ...f, [k]: v }));
  const show = (next: Filters, nextPage = 1) => {
    const p = new URLSearchParams();
    if (next.who.trim()) p.set("who", next.who.trim());
    if (next.kind) p.set("kind", next.kind);
    if (next.from) p.set("from", next.from);
    if (next.to) p.set("to", next.to);
    if (nextPage > 1) p.set("page", String(nextPage));
    setParams(p);
  };
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (form.from && form.to && form.from > form.to) return setFormError("From must be on or before To.");
    setFormError(null);
    show(form);
  };
  const clear = () => {
    const empty = { who: "", kind: "", from: "", to: "" };
    setForm(empty);
    setFormError(null);
    show(empty);
  };

  const current = result?.search === search ? result.page : null;
  const now = new Date();
  const when = (iso: string) => formatWhen(iso, now, timeZone, { withDate: true });
  const filtered = Boolean(applied.who.trim() || applied.kind || applied.from || applied.to);

  return (
    <div className="gcpe-admin-history">
      <h1>Admin history</h1>
      <p>Changes made on Users, Calendar access, Organizations, Sectors, themes and tags, and Cabinet change: who made each one and when, newest first.</p>

      <form aria-label="Filter admin history" onSubmit={submit} noValidate>
        <div className="gcpe-field-row">
          <div className="gcpe-field">
            <label htmlFor="history-who">Who</label>
            <input id="history-who" type="search" maxLength={100} value={form.who} aria-describedby="history-who-hint" onChange={(e) => set("who", e.target.value)} />
          </div>
          <div className="gcpe-field">
            <label htmlFor="history-kind">What</label>
            <select id="history-kind" value={form.kind} onChange={(e) => set("kind", e.target.value)}>
              {KIND_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>
          <div className="gcpe-field">
            <label htmlFor="history-from">From</label>
            <input id="history-from" type="date" value={form.from} onChange={(e) => set("from", e.target.value)} />
          </div>
          <div className="gcpe-field">
            <label htmlFor="history-to">To</label>
            <input id="history-to" type="date" value={form.to} onChange={(e) => set("to", e.target.value)} />
          </div>
          <Button type="submit">Show</Button>
          {filtered && (
            <Button variant="secondary" onPress={clear}>
              Clear filters
            </Button>
          )}
        </div>
        <p id="history-who-hint" className="gcpe-hint">
          Part of the name of the person who made the change.
        </p>
        {formError && <p role="alert">{formError}</p>}
      </form>

      {loadError && <InlineAlert variant="danger" role="alert" description="Couldn't load the admin history." />}
      {!current && !loadError && <p>Loading…</p>}
      {current && (
        <>
          <p role="status">{current.total === 0 ? (filtered ? "No changes match these filters." : "No changes recorded yet.") : `${current.total} ${current.total === 1 ? "change" : "changes"}`}</p>
          {current.items.length > 0 && (
            <TableScroll label="Admin history">
              <table className="gcpe-table">
                <caption>Admin history, newest first</caption>
                <thead>
                  <tr>
                    <th scope="col">When</th>
                    <th scope="col">Who</th>
                    <th scope="col">What</th>
                  </tr>
                </thead>
                <tbody>
                  {current.items.map((e) => (
                    <tr key={e.id}>
                      <td>{when(e.at)}</td>
                      <td>{e.actorName}</td>
                      <td>{capitalised(describeEntry(e, (k) => orgNames.get(k), when))}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableScroll>
          )}
          <Pagination page={current.page} pageSize={current.pageSize} total={current.total} onPageChange={(p) => show(applied, p)} />
        </>
      )}
    </div>
  );
}

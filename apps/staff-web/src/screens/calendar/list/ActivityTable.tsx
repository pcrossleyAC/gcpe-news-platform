import { useCallback, useEffect, useRef, useState } from "react";
import { InlineAlert } from "@bcgov/design-system-react-components";
import { Link } from "react-router";
import { LIST_COLUMN_LABELS, LIST_COLUMNS, LIST_PAGE_SIZE, LIST_SORTS, type HideableColumn, type ListColumn, type ListQuery, type ListRow, type ListSort } from "@gcpe/calendar-contract";
import { ApiError } from "../../../api/client";
import { Button } from "../../../shared/BusyButton";
import { messagesOf } from "../../admin/messages";
import { listApi } from "./api";
import { CellContent, needsReviewOf, type TableTools } from "./cells";
import { todayIn } from "./dates";

const isSortable = (c: ListColumn): c is ListSort => (LIST_SORTS as readonly string[]).includes(c);
const plural = (n: number) => `${n} ${n === 1 ? "activity" : "activities"}`;

/** A 403 carries the server's own reason; anything else gets the general message. */
export const loadFailure = (caught: unknown, general: string) => (caught instanceof ApiError && caught.status === 403 ? messagesOf(caught).join(" ") : general);

/** The grid (UCFlexiGrid): 30 rows at a time as the end scrolls into view, as legacy's did. */
/** Legacy's short column names, spelled out (the Help page's glossary explains each). */
const SPELLED_OUT: Partial<Record<ListColumn, string>> = {
  commMaterials: "Communication materials",
  commContact: "Communications contact",
  governmentRep: "Government representative",
  leadOrg: "Lead organization",
};

function ColumnLabel({ column }: { column: ListColumn }): React.JSX.Element {
  const full = SPELLED_OUT[column];
  return full ? <abbr title={full}>{LIST_COLUMN_LABELS[column]}</abbr> : <>{LIST_COLUMN_LABELS[column]}</>;
}

export function ActivityTable({ query, hidden, timeZone, reloadToken, onSort, tools, returnedFrom = null }: {
  /** The activity just saved, reviewed or left (Cancel): its row is brought into view, marked and
   * given focus once it's on the page, so the list picks up where the user was. */
  returnedFrom?: number | null;
  query: ListQuery;
  hidden: readonly HideableColumn[];
  timeZone: string;
  reloadToken: number;
  onSort: (sort: ListSort, dir: "asc" | "desc") => void;
  tools?: TableTools;
}): React.JSX.Element {
  const [rows, setRows] = useState<ListRow[]>([]);
  const [total, setTotal] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const latest = useRef(0);
  const key = JSON.stringify(query);

  useEffect(() => {
    const call = ++latest.current;
    setRows([]);
    setTotal(null);
    setError(null);
    setLoading(true);
    listApi.page(query, 0).then(
      (p) => {
        if (call !== latest.current) return;
        setRows(p.rows);
        setTotal(p.total);
        setLoading(false);
      },
      (caught: unknown) => {
        if (call !== latest.current) return;
        setError(loadFailure(caught, "Couldn't load activities."));
        setLoading(false);
      },
    );
    // `key` stands for `query`: a new object with the same content mustn't reload.
  }, [key, reloadToken]); // eslint-disable-line react-hooks/exhaustive-deps

  const more = useCallback(() => {
    if (loading || total === null || rows.length >= total) return;
    // A page from an older query is dropped: `latest` moves on when the query does.
    const call = latest.current;
    setLoading(true);
    listApi.page(query, rows.length).then(
      (p) => {
        if (call !== latest.current) return;
        setRows((r) => [...r, ...p.rows.filter((x) => !r.some((y) => y.id === x.id))]);
        setTotal(p.total);
        setError(null);
        setLoading(false);
      },
      (caught: unknown) => {
        if (call !== latest.current) return;
        setError(loadFailure(caught, "Couldn't load more activities."));
        setLoading(false);
      },
    );
  }, [loading, total, rows.length, key]); // eslint-disable-line react-hooks/exhaustive-deps

  const sentinel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = sentinel.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const o = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) more();
    });
    o.observe(el);
    return () => o.disconnect();
  }, [more]);

  // Once per arrival: the row the user came back from, in view with focus on its link.
  const broughtBack = useRef<number | null>(null);
  const tbody = useRef<HTMLTableSectionElement>(null);
  useEffect(() => {
    if (returnedFrom === null || broughtBack.current === returnedFrom) return;
    const row = tbody.current?.querySelector<HTMLTableRowElement>(`tr[data-activity-id="${returnedFrom}"]`);
    if (!row) return;
    broughtBack.current = returnedFrom;
    const link = row.querySelector<HTMLAnchorElement>(".gcpe-col-title a") ?? row.querySelector<HTMLAnchorElement>("a");
    row.scrollIntoView?.({ block: "center" });
    link?.focus({ preventScroll: true });
  }, [rows, returnedFrom]);

  const update = (id: number) => (patch: Partial<ListRow>) => setRows((rs) => rs.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  const columns = LIST_COLUMNS.filter((c) => c === "activity" || !(hidden as readonly string[]).includes(c));
  const today = todayIn(timeZone);

  if (error && rows.length === 0) return <InlineAlert variant="danger" role="alert" description={error} />;
  return (
    <section aria-labelledby="list-results-heading">
      <h2 id="list-results-heading">Activities</h2>
      <p role="status">{total === null ? "Loading activities…" : total === 0 ? "No activities match." : `Showing ${rows.length} of ${plural(total)}.`}</p>
      {rows.length > 0 && (
        <div className="gcpe-calendar-table-wrap">
          <table className="gcpe-calendar-table">
            <caption className="gcpe-visually-hidden">{`Activities, sorted by ${LIST_COLUMN_LABELS[query.sort]}, ${query.dir === "asc" ? "ascending" : "descending"}`}</caption>
            <thead>
              <tr>
                {columns.map((c) => (
                  <th key={c} scope="col" className={`gcpe-col-${c}`} aria-sort={query.sort === c ? (query.dir === "asc" ? "ascending" : "descending") : undefined}>
                    {isSortable(c) ? (
                      <button type="button" className="gcpe-sort" onClick={() => onSort(c, query.sort === c && query.dir === "asc" ? "desc" : "asc")}>
                        <ColumnLabel column={c} />
                      </button>
                    ) : (
                      <ColumnLabel column={c} />
                    )}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody ref={tbody}>
              {rows.map((r) => (
                <tr
                  key={r.id}
                  data-activity-id={r.id}
                  className={[r.isDeleted && "gcpe-deleted", r.id === returnedFrom && "gcpe-calendar-row--returned"].filter(Boolean).join(" ") || undefined}
                >
                  {columns.map((c) => {
                    const flagged = needsReviewOf(c, r);
                    return (
                      <td key={c} data-label={LIST_COLUMN_LABELS[c]} className={`gcpe-col-${c}${flagged ? " gcpe-needs-review" : ""}`}>
                        <CellContent column={c} row={r} today={today} timeZone={timeZone} tools={tools} update={update(r.id)} metaUnderTitle={columns.includes("title")} />
                        {flagged && <span className="gcpe-visually-hidden"> (changed, needs review)</span>}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {rows.length > 0 && (
        <p className="gcpe-hint">
          <Link to="/help#glossary-calendar">What the column names mean</Link>
        </p>
      )}
      {error && rows.length > 0 && <p role="alert">{error}</p>}
      {total !== null && rows.length < total && (
        <>
          <div ref={sentinel} />
          <Button variant="secondary" isPending={loading} pendingLabel="Loading…" onPress={more}>{`Show ${Math.min(LIST_PAGE_SIZE, total - rows.length)} more`}</Button>
        </>
      )}
    </section>
  );
}

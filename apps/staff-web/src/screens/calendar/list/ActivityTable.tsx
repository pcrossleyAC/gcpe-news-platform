import { useCallback, useEffect, useRef, useState } from "react";
import { Button, InlineAlert } from "@bcgov/design-system-react-components";
import { LIST_COLUMN_LABELS, LIST_COLUMNS, LIST_PAGE_SIZE, LIST_SORTS, type HideableColumn, type ListColumn, type ListQuery, type ListRow, type ListSort } from "@gcpe/calendar-contract";
import { listApi } from "./api";
import { CellContent, needsReviewOf, type TableTools } from "./cells";
import { todayIn } from "./dates";

const isSortable = (c: ListColumn): c is ListSort => (LIST_SORTS as readonly string[]).includes(c);
const plural = (n: number) => `${n} ${n === 1 ? "activity" : "activities"}`;

/** The grid (UCFlexiGrid): 30 rows at a time as the end scrolls into view, as legacy's did. */
export function ActivityTable({ query, hidden, timeZone, reloadToken, onSort, tools }: {
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
      () => {
        if (call !== latest.current) return;
        setError("Couldn't load activities.");
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
        setLoading(false);
      },
      () => {
        if (call !== latest.current) return;
        setError("Couldn't load more activities.");
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
                  <th key={c} scope="col" aria-sort={query.sort === c ? (query.dir === "asc" ? "ascending" : "descending") : undefined}>
                    {isSortable(c) ? (
                      <button type="button" className="gcpe-sort" onClick={() => onSort(c, query.sort === c && query.dir === "asc" ? "desc" : "asc")}>
                        {LIST_COLUMN_LABELS[c]}
                      </button>
                    ) : (
                      LIST_COLUMN_LABELS[c]
                    )}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className={r.isDeleted ? "gcpe-deleted" : undefined}>
                  {columns.map((c) => {
                    const flagged = needsReviewOf(c, r);
                    return (
                      <td key={c} className={flagged ? "gcpe-needs-review" : undefined}>
                        <CellContent column={c} row={r} today={today} timeZone={timeZone} tools={tools} update={update(r.id)} />
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
      {error && rows.length > 0 && <p role="alert">{error}</p>}
      {total !== null && rows.length < total && (
        <>
          <div ref={sentinel} />
          <Button variant="secondary" isDisabled={loading} onPress={more}>{`Show ${Math.min(LIST_PAGE_SIZE, total - rows.length)} more`}</Button>
        </>
      )}
    </section>
  );
}

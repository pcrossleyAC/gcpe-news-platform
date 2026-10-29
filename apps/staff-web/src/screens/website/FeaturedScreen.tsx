import { useEffect, useState } from "react";
import { Link } from "react-router";
import { TableScroll } from "../../shared/TableScroll";
import { InlineAlert } from "@bcgov/design-system-react-components";
import { apiFetch } from "../../api/client";
import { useDocumentTitle } from "../../shared/useDocumentTitle";
import type { FeaturedWhereRow } from "./types";

/**
 * `/hub/website/featured` (task-5-brief.md): "What's featured where" — read-only for every
 * role (release screens' FeatureSwitches, Task 4, are the only place that sets these).
 */
export function FeaturedScreen(): React.JSX.Element {
  useDocumentTitle("What’s featured where");
  const [rows, setRows] = useState<FeaturedWhereRow[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    apiFetch<FeaturedWhereRow[]>("/nrms/api/site/features").then(setRows, () => setLoadError("Couldn't load what's featured where."));
  }, []);

  if (loadError) {
    return (
      <div className="gcpe-featured">
        <h1>What&rsquo;s featured where</h1>
        <InlineAlert variant="danger" role="alert" description={loadError} />
      </div>
    );
  }
  if (!rows) return <p>Loading…</p>;

  return (
    <div className="gcpe-featured">
      <h1>What&rsquo;s featured where</h1>
      {rows.length === 0 ? (
        <p>Nothing is currently Top or Feature anywhere.</p>
      ) : (
        <TableScroll label="What’s featured where">
          <table className="gcpe-table gcpe-featured__table">
            {/* Named for assistive technology only: the h1 above already says it on screen. */}
            <caption className="gcpe-visually-hidden">What&rsquo;s featured where</caption>
            <thead>
              <tr>
                <th scope="col">Place</th>
                <th scope="col">Top</th>
                <th scope="col">Feature</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={`${row.kind}:${row.key}`}>
                  <th scope="row">{row.label}</th>
                  <td>{row.top ? <Link to={`/releases/${row.top.id}`}>{row.top.headline}</Link> : "—"}</td>
                  <td>{row.feature ? <Link to={`/releases/${row.feature.id}`}>{row.feature.headline}</Link> : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableScroll>
      )}
    </div>
  );
}

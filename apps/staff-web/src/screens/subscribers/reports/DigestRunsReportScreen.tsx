import { InlineAlert } from "@bcgov/design-system-react-components";
import { useTenantTimeZone } from "../../../format/tenantTimeZone";
import { useDocumentTitle } from "../../../shared/useDocumentTitle";
import { Pagination } from "../../releases/Pagination";
import { CsvLink } from "./CsvLink";
import { HandedOffNote } from "./HandedOffNote";
import { reportErrorText } from "./errors";
import { bcDateTime } from "./format";
import { RangeForm } from "./RangeForm";
import { useRangedReport } from "./useRangedReport";
import type { DigestRunRow, RangedPage } from "./types";

/** `/hub/subscribers/reports/digest-runs` (spec §8): each 17:00 digest run in the range, counted
 * in emails (one per subscriber). */
export function DigestRunsReportScreen(): React.JSX.Element {
  useDocumentTitle("Daily digest runs");
  const timeZone = useTenantTimeZone();
  const { report, params, shown, formKey, csvHref, apply } = useRangedReport<RangedPage<DigestRunRow>>("/nod/api/reports/digest-runs");
  const d = report.data;
  return (
    <div className="gcpe-reports">
      <h1>Daily digest runs</h1>
      <p>
        Each daily digest run: one email per subscriber. Items in window are the releases in the run&rsquo;s window as they stand now: an
        item withdrawn since the run no longer counts.
      </p>
      <HandedOffNote />
      <RangeForm key={formKey} from={shown.from} to={shown.to} onApply={apply} />
      {report.error ? <InlineAlert variant="danger" role="alert" description={reportErrorText(report.error)} /> : null}
      {!d && !report.error && <p>Loading…</p>}
      {d && (
        <>
          <CsvLink href={csvHref("/nod/api/reports/digest-runs.csv")}>Download (CSV)</CsvLink>
          {d.items.length > 0 ? (
            <table aria-label="Daily digest runs">
              <thead>
                <tr>
                  <th scope="col">Run</th>
                  <th scope="col">Ran at</th>
                  <th scope="col">Items in window</th>
                  <th scope="col">Subscribers</th>
                  <th scope="col">Handed off, not bounced</th>
                  <th scope="col">Bounced</th>
                  <th scope="col">Not sent</th>
                </tr>
              </thead>
              <tbody>
                {d.items.map((r) => (
                  <tr key={r.cutoff}>
                    <th scope="row">{bcDateTime(r.cutoff, timeZone)}</th>
                    <td>{bcDateTime(r.ranAt, timeZone)}</td>
                    <td>{r.items}</td>
                    <td>{r.subscribers}</td>
                    <td>{r.handedOffNotBounced}</td>
                    <td>{r.bounced}</td>
                    <td>{r.notSent}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p>No digest ran in this range.</p>
          )}
          <Pagination page={d.page} pageSize={d.pageSize} total={d.total} onPageChange={(n) => params.update({ page: String(n) })} />
        </>
      )}
    </div>
  );
}

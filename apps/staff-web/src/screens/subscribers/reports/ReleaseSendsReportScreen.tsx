import { InlineAlert } from "@bcgov/design-system-react-components";
import { useTenantTimeZone } from "../../../format/tenantTimeZone";
import { useDocumentTitle } from "../../../shared/useDocumentTitle";
import { Pagination } from "../../releases/Pagination";
import { CsvLink } from "./CsvLink";
import { reportErrorText } from "./errors";
import { bcDateTime } from "./format";
import { RangeForm } from "./RangeForm";
import { useRangedReport } from "./useRangedReport";
import type { ModeCounts, RangedPage, ReleaseSendRow } from "./types";

const COLUMNS = ["Recipients", "Delivered", "Bounced", "Not sent"];

function ModeCells({ c }: { c: ModeCounts }): React.JSX.Element {
  return (
    <>
      <td>{c.recipients}</td>
      <td>{c.delivered}</td>
      <td>{c.bounced}</td>
      <td>{c.notSent}</td>
    </>
  );
}

/** `/hub/subscribers/reports/release-sends` (spec §8): as-it-happens and media-list emails per
 * release or alert published in the range. */
export function ReleaseSendsReportScreen(): React.JSX.Element {
  useDocumentTitle("Sends per release");
  const timeZone = useTenantTimeZone();
  const { report, params, shown, csvHref, apply } = useRangedReport<RangedPage<ReleaseSendRow>>("/nod/api/reports/release-sends");
  const d = report.data;
  return (
    <div className="gcpe-reports">
      <h1>Sends per release</h1>
      <p>
        As-it-happens and media-list emails for each release or alert published in the range. Delivered means handed to Distribution and
        not bounced; not sent includes sends still going out. Daily digest emails are in Daily digest runs.
      </p>
      <RangeForm key={`${shown.from}|${shown.to}`} from={shown.from} to={shown.to} onApply={apply} />
      {report.error ? <InlineAlert variant="danger" role="alert" description={reportErrorText(report.error)} /> : null}
      {!d && !report.error && <p>Loading…</p>}
      {d && (
        <>
          <p>{`${d.total} ${d.total === 1 ? "release" : "releases"} sent from ${d.from} to ${d.to}.`}</p>
          <CsvLink href={csvHref("/nod/api/reports/release-sends.csv")}>Download (CSV)</CsvLink>
          {d.items.length > 0 ? (
            <table aria-label="Sends per release">
              <thead>
                <tr>
                  <th scope="col" rowSpan={2}>Published</th>
                  <th scope="col" rowSpan={2}>Release</th>
                  <th scope="col" rowSpan={2}>Type</th>
                  <th scope="colgroup" colSpan={4}>As it happens</th>
                  <th scope="colgroup" colSpan={4}>Media lists</th>
                </tr>
                <tr>
                  {["aih", "media"].flatMap((g) => COLUMNS.map((c) => <th key={`${g}-${c}`} scope="col">{c}</th>))}
                </tr>
              </thead>
              <tbody>
                {d.items.map((r) => (
                  <tr key={r.itemKey}>
                    <td>{bcDateTime(r.publishedAt, timeZone)}</td>
                    <th scope="row">{r.title}</th>
                    <td>{r.type}</td>
                    <ModeCells c={r.asItHappens} />
                    <ModeCells c={r.media} />
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p>No releases were sent in this range.</p>
          )}
          <Pagination page={d.page} pageSize={d.pageSize} total={d.total} onPageChange={(n) => params.update({ page: String(n) })} />
        </>
      )}
    </div>
  );
}

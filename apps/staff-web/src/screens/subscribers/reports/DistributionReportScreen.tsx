import { InlineAlert } from "@bcgov/design-system-react-components";
import { useDocumentTitle } from "../../../shared/useDocumentTitle";
import { CsvLink } from "./CsvLink";
import { reportErrorText } from "./errors";
import { RangeForm } from "./RangeForm";
import { useRangedReport } from "./useRangedReport";
import type { DeliveryCounts, DistributionReport } from "./types";

const HEADINGS = ["Sent", "Delivered", "Hard bounces", "Soft bounces", "Failed"];

function CountCells({ c }: { c: DeliveryCounts }): React.JSX.Element {
  return (
    <>
      <td>{c.sent}</td>
      <td>{c.delivered}</td>
      <td>{c.hardBounced}</td>
      <td>{c.softBounced}</td>
      <td>{c.failed}</td>
    </>
  );
}

/** `/hub/subscribers/reports/distribution` (spec §8): what Distribution sent, by BC day and sending
 * app. Distribution answers this itself; when it's down, the screen says so. */
export function DistributionReportScreen(): React.JSX.Element {
  useDocumentTitle("Distribution sent and bounced");
  const { report, shown, formKey, csvHref, apply } = useRangedReport<DistributionReport>("/nod/api/reports/distribution");
  const d = report.data;
  return (
    <div className="gcpe-reports">
      <h1>Distribution sent and bounced</h1>
      <p>
        Every email Distribution sent, by BC day and sending app. Delivered is sent less bounces. Failed emails were never sent and are
        counted on the day they were queued.
      </p>
      <RangeForm key={formKey} from={shown.from} to={shown.to} onApply={apply} />
      {report.error ? <InlineAlert variant="danger" role="alert" description={reportErrorText(report.error)} /> : null}
      {!d && !report.error && <p>Loading…</p>}
      {d && (
        <>
          <CsvLink href={csvHref("/nod/api/reports/distribution.csv")}>Download (CSV)</CsvLink>
          <table aria-label="Totals">
            <thead>
              <tr>
                <th scope="col">Sent by</th>
                {HEADINGS.map((h) => (
                  <th key={h} scope="col">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {d.apps.map((a) => (
                <tr key={a.app}>
                  <th scope="row">{a.app}</th>
                  <CountCells c={a} />
                </tr>
              ))}
              <tr>
                <th scope="row">All senders</th>
                <CountCells c={d.totals} />
              </tr>
            </tbody>
          </table>
          {d.days.length > 0 ? (
            <table aria-label="By day">
              <thead>
                <tr>
                  <th scope="col">Date</th>
                  <th scope="col">Sent by</th>
                  {HEADINGS.map((h) => (
                    <th key={h} scope="col">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {d.days.map((day) => (
                  <tr key={`${day.date}|${day.app}`}>
                    <th scope="row">{day.date}</th>
                    <td>{day.app}</td>
                    <CountCells c={day} />
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p>Nothing was sent in this range.</p>
          )}
        </>
      )}
    </div>
  );
}

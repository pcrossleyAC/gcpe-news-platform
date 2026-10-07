import { Link } from "react-router";
import { InlineAlert } from "@bcgov/design-system-react-components";
import { useTenantTimeZone } from "../../../format/tenantTimeZone";
import { useSession } from "../../../session/SessionContext";
import { useDocumentTitle } from "../../../shared/useDocumentTitle";
import { Pagination } from "../../releases/Pagination";
import { canEditSubscribers } from "../access";
import { CsvLink } from "./CsvLink";
import { reportErrorText } from "./errors";
import { bcDate, bcDateTime } from "./format";
import { reportUrl } from "./reportUrl";
import { useReport } from "./useReport";
import { useReportParams } from "./useReportParams";
import type { UnsubscribeRow, UnsubscribesPage } from "./types";

const HOW: Record<UnsubscribeRow["how"], string> = { subscriber: "Unsubscribed", staff: "Deleted by staff" };
const STATUS: Record<UnsubscribeRow["status"], string> = { pending: "Pending", active: "Active", disabled: "Disabled", deleted: "Deleted" };

/** `/hub/subscribers/reports/unsubscribes` (spec §8; legacy RecentUnsubscribersReport): the last 90
 * days, fixed. Viewers export daily counts; Editors and Admins also export addresses (Q37). */
export function UnsubscribesReportScreen(): React.JSX.Element {
  useDocumentTitle("Recent unsubscribes");
  const canExport = canEditSubscribers(useSession());
  const timeZone = useTenantTimeZone();
  const params = useReportParams();
  const report = useReport<UnsubscribesPage>(reportUrl("/nod/api/reports/unsubscribes", { page: params.page > 1 ? params.page : undefined }));
  const d = report.data;

  return (
    <div className="gcpe-reports">
      <h1>Recent unsubscribes</h1>
      <p>
        Everyone whose latest unsubscribe, or deletion by staff, was in the last 90 days. Subscribers disabled because their email bounced
        aren&rsquo;t listed: find them under Subscribers with the Disabled status.
      </p>
      {report.error ? <InlineAlert variant="danger" role="alert" description={reportErrorText(report.error)} /> : null}
      {!d && !report.error && <p>Loading…</p>}
      {d && (
        <>
          <p>{`Since ${d.since}: ${d.summary.subscribed} new subscriptions, ${d.summary.resubscribed} returning, ${d.summary.unsubscribed} unsubscribed, ${d.summary.staffDeleted} deleted by staff.`}</p>
          <p>{d.total === 1 ? `1 person unsubscribed or was deleted since ${d.since}.` : `${d.total} people unsubscribed or were deleted since ${d.since}.`}</p>
          <CsvLink href="/nod/api/reports/unsubscribes/daily.csv">Download daily counts (CSV)</CsvLink>
          {canExport && <CsvLink href="/nod/api/reports/unsubscribes.csv">Download list with addresses (CSV)</CsvLink>}
          {d.items.length > 0 ? (
            <table aria-label="Recent unsubscribes">
              <thead>
                <tr>
                  <th scope="col">Email</th>
                  <th scope="col">How</th>
                  <th scope="col">When</th>
                  <th scope="col">Status now</th>
                  <th scope="col">Registered</th>
                </tr>
              </thead>
              <tbody>
                {d.items.map((u) => (
                  <tr key={u.subscriberId}>
                    <td>
                      <Link to={`/subscribers/${u.subscriberId}`}>{u.email}</Link>
                    </td>
                    <td>{HOW[u.how]}</td>
                    <td>{bcDateTime(u.at, timeZone)}</td>
                    <td>{STATUS[u.status]}</td>
                    <td>{bcDate(u.registeredAt, timeZone)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p>No one unsubscribed in the last 90 days.</p>
          )}
          <Pagination page={d.page} pageSize={d.pageSize} total={d.total} onPageChange={(n) => params.update({ page: String(n) })} />
        </>
      )}
    </div>
  );
}

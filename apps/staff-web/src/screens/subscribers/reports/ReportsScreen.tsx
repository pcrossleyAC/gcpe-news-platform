import { Link } from "react-router";
import { useDocumentTitle } from "../../../shared/useDocumentTitle";

const REPORTS = [
  { to: "subscribers-by-list", name: "Active subscribers by list", about: "who receives each list now, with as-it-happens and digest counts." },
  { to: "unsubscribes", name: "Recent unsubscribes", about: "everyone who unsubscribed or was deleted in the last 90 days." },
  { to: "release-sends", name: "Sends per release", about: "as-it-happens and media-list emails for each release: handed off and not bounced, bounced, and not sent." },
  { to: "digest-runs", name: "Daily digest runs", about: "each 17:00 digest: subscribers, handed off and not bounced, bounced, and not sent." },
  { to: "distribution", name: "Distribution sent and bounced", about: "everything Distribution sent, by day and sending app." },
];

/** `/hub/subscribers/reports` (spec §8 Reports). */
export function ReportsScreen(): React.JSX.Element {
  useDocumentTitle("Reports");
  return (
    <div className="gcpe-reports">
      <h1>Reports</h1>
      <p>Every report can be downloaded as a CSV file. Dates and times are BC time.</p>
      <ul>
        {REPORTS.map((r) => (
          <li key={r.to}>
            <Link to={`/subscribers/reports/${r.to}`}>{r.name}</Link>: {r.about}
          </li>
        ))}
      </ul>
      <p>CSV files with email addresses are for News On Demand editors and administrators.</p>
    </div>
  );
}

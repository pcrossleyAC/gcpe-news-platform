import { Link } from "react-router";
import { InlineAlert } from "@bcgov/design-system-react-components";
import { useTenantTimeZone } from "../../../format/tenantTimeZone";
import { useSession } from "../../../session/SessionContext";
import { useDocumentTitle } from "../../../shared/useDocumentTitle";
import { Pagination } from "../../releases/Pagination";
import { canEditSubscribers } from "../access";
import { timingLabel } from "../labels";
import { CsvLink } from "./CsvLink";
import { reportErrorText } from "./errors";
import { bcDate } from "./format";
import { reportUrl } from "./reportUrl";
import { useReport } from "./useReport";
import { useReportParams } from "./useReportParams";
import type { MembersPage, SubscribersByListReport, TimingCounts, TimingFilter } from "./types";

const TIMING_OPTIONS: { value: TimingFilter; label: string }[] = [
  { value: "any", label: "Any timing" },
  { value: "as-it-happens", label: "As it happens" },
  { value: "digest", label: "Daily digest" },
];
const SOURCE_LABELS: Record<string, string> = { self: "Signed up", admin: "Added by staff", "media-hub": "Media Hub", "manual-media": "Added by hand" };

function CountsRow({ listKey, name, counts }: { listKey: string; name: string; counts: TimingCounts }): React.JSX.Element {
  return (
    <tr>
      <th scope="row">{name}</th>
      <td>{counts.subscribers}</td>
      <td>{counts.asItHappens}</td>
      <td>{counts.digest}</td>
      <td>
        <Link to={`?${new URLSearchParams({ list: listKey }).toString()}`} aria-label={`Show members of ${name}`}>
          Show members
        </Link>
      </td>
    </tr>
  );
}

function CountsTable({ label, children }: { label: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <table aria-label={label}>
      <thead>
        <tr>
          <th scope="col">List</th>
          <th scope="col">Subscribers</th>
          <th scope="col">As it happens</th>
          <th scope="col">Daily digest</th>
          <th scope="col">Members</th>
        </tr>
      </thead>
      <tbody>{children}</tbody>
    </table>
  );
}

/** `/hub/subscribers/reports/subscribers-by-list` (spec §8): active subscribers per list now, and
 * the members of one list (or All news, or everyone) by timing. The list key, timing and page
 * live in the URL; the members CSV is for Editors and Admins (Q37). */
export function SubscribersByListReportScreen(): React.JSX.Element {
  useDocumentTitle("Active subscribers by list");
  const canExport = canEditSubscribers(useSession());
  const timeZone = useTenantTimeZone();
  const params = useReportParams();
  const list = params.value("list");
  const timing = TIMING_OPTIONS.find((o) => o.value === params.value("timing"))?.value ?? "any";
  const summary = useReport<SubscribersByListReport>("/nod/api/reports/subscribers-by-list");
  const members = useReport<MembersPage>(
    list ? reportUrl("/nod/api/reports/subscribers-by-list/members", { list, timing, page: params.page > 1 ? params.page : undefined }) : null,
  );

  return (
    <div className="gcpe-reports">
      <h1>Active subscribers by list</h1>
      <p>Who receives each list now. Active subscribers only.</p>
      {summary.error ? <InlineAlert variant="danger" role="alert" description={reportErrorText(summary.error)} /> : null}
      {!summary.data && !summary.error && <p>Loading…</p>}
      {summary.data && (
        <>
          <CsvLink href="/nod/api/reports/subscribers-by-list.csv">Download counts (CSV)</CsvLink>
          <CountsTable label="Everyone">
            <CountsRow listKey="all" name="All active subscribers" counts={summary.data.all} />
            <CountsRow listKey="*" name="All news" counts={summary.data.allNews} />
          </CountsTable>
          {summary.data.categories
            .filter((c) => c.lists.length > 0)
            .map((c) => (
              <section key={c.key} aria-labelledby={`report-category-${c.key}`}>
                <h2 id={`report-category-${c.key}`}>{c.name}</h2>
                <CountsTable label={c.name}>
                  {c.lists.map((l) => (
                    <CountsRow key={l.listKey} listKey={l.listKey} name={l.active ? l.name : `${l.name} (retired)`} counts={l} />
                  ))}
                </CountsTable>
              </section>
            ))}
        </>
      )}

      {list && (
        <section aria-labelledby="report-members-heading">
          <h2 id="report-members-heading">{members.data ? `Members: ${members.data.listName}` : "Members"}</h2>
          <label htmlFor="report-timing">Timing</label>
          <select id="report-timing" value={timing} onChange={(e) => params.update({ timing: e.target.value === "any" ? null : e.target.value })}>
            {TIMING_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
          {members.error ? <InlineAlert variant="danger" role="alert" description={reportErrorText(members.error)} /> : null}
          {members.data && (
            <>
              <p>{`${members.data.total} active ${members.data.total === 1 ? "subscriber" : "subscribers"}.`}</p>
              {canExport && (
                <CsvLink href={reportUrl("/nod/api/reports/subscribers-by-list/members.csv", { list, timing })}>Download members (CSV)</CsvLink>
              )}
              {members.data.items.length > 0 && (
                <table aria-label="Members">
                  <thead>
                    <tr>
                      <th scope="col">Email</th>
                      <th scope="col">Timing</th>
                      <th scope="col">Source</th>
                      <th scope="col">Registered</th>
                    </tr>
                  </thead>
                  <tbody>
                    {members.data.items.map((m) => (
                      <tr key={m.id}>
                        <td>
                          <Link to={`/subscribers/${m.id}`}>{m.email}</Link>
                        </td>
                        <td>{timingLabel(m)}</td>
                        <td>{SOURCE_LABELS[m.source] ?? m.source}</td>
                        <td>{bcDate(m.createdAt, timeZone)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              <Pagination page={members.data.page} pageSize={members.data.pageSize} total={members.data.total} onPageChange={(n) => params.update({ page: String(n) })} />
            </>
          )}
        </section>
      )}
    </div>
  );
}

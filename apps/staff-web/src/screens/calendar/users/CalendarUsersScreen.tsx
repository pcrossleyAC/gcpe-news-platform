import { useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import { InlineAlert, TextField } from "@bcgov/design-system-react-components";
import { apiFetch } from "../../../api/client";
import { useDocumentTitle } from "../../../shared/useDocumentTitle";
import { calendarRoleLabel } from "../../admin/calendar-access/calendar-roles";
import { RANK_OPTIONS, rowLabel, type CalendarUserRow } from "./types";

const rankLabel = (rank: number | null): string => (rank ? (RANK_OPTIONS.find((o) => o.value === String(rank))?.label ?? String(rank)) : "");

/** `/hub/calendar/users`: legacy's user list (Admin/UserList.aspx.cs), one row per user and ministry. */
export function CalendarUsersScreen(): React.JSX.Element {
  useDocumentTitle("Calendar users");
  const [inactive, setInactive] = useState(false);
  const [noAccess, setNoAccess] = useState(false);
  const [filter, setFilter] = useState("");
  const [rows, setRows] = useState<CalendarUserRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const latest = useRef(0);

  useEffect(() => {
    const call = ++latest.current;
    const q = [inactive && "inactive=1", noAccess && "noAccess=1"].filter(Boolean).join("&");
    apiFetch<CalendarUserRow[]>(`/calendar/api/users${q ? `?${q}` : ""}`).then(
      (r) => {
        if (call === latest.current) {
          setRows(r);
          setError(null);
        }
      },
      () => {
        if (call === latest.current) setError("Couldn't load Calendar users.");
      },
    );
  }, [inactive, noAccess]);

  const needle = filter.trim().toLowerCase();
  const shown = (rows ?? []).filter((r) => !needle || r.displayName.toLowerCase().includes(needle) || (r.ministryAbbreviation ?? "").toLowerCase().includes(needle));
  return (
    <div>
      <h1>Calendar users</h1>
      <p>Contact details and comm-contact ranks are kept here. Roles, ministries and accounts are saved in Core and reach the Calendar within a minute.</p>
      {error && <InlineAlert variant="danger" role="alert" description={error} />}
      <TextField label="Find by name or ministry" value={filter} onChange={setFilter} />
      <div className="gcpe-check">
        <input id="calendar-users-inactive" type="checkbox" checked={inactive} onChange={(e) => setInactive(e.target.checked)} />
        <label htmlFor="calendar-users-inactive">Show inactive users, including those with no email</label>
      </div>
      <div className="gcpe-check">
        <input id="calendar-users-no-access" type="checkbox" checked={noAccess} onChange={(e) => setNoAccess(e.target.checked)} />
        <label htmlFor="calendar-users-no-access">Show users without Calendar access</label>
      </div>
      {rows === null && !error && <p>Loading…</p>}
      {rows !== null && (
        <table className="gcpe-table">
          <caption className="gcpe-visually-hidden">Calendar users, one row per user and ministry</caption>
          <thead>
            <tr>
              <th scope="col">Name</th>
              <th scope="col">Ministry</th>
              <th scope="col">Comm contact</th>
              <th scope="col">Calendar role</th>
              <th scope="col">Active</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((r) => (
              <tr key={`${r.userId}:${r.ministryKey ?? ""}`}>
                <td>
                  {/* The link keeps legacy's full row label as its name, so each row's link stays distinct. */}
                  <Link to={`/calendar/users/${r.userId}`}>
                    {r.displayName} <span className="gcpe-visually-hidden">{rowLabel(r).slice(r.displayName.length).trim()}</span>
                  </Link>
                </td>
                <td>{r.ministryAbbreviation ?? r.ministryKey ?? ""}</td>
                <td>{rankLabel(r.rank)}</td>
                <td>{r.role ? calendarRoleLabel(r.role) : "No Calendar access"}</td>
                <td>{r.isActive ? "Yes" : "No"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

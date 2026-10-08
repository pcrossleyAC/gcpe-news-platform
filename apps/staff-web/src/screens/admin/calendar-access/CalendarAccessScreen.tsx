import { useCallback, useEffect, useRef, useState } from "react";
import { Button, InlineAlert, TextField } from "@bcgov/design-system-react-components";
import { apiFetch } from "../../../api/client";
import { useSession } from "../../../session/SessionContext";
import { useDocumentTitle } from "../../../shared/useDocumentTitle";
import { AccessEditor, actorFor, LOCKED_MESSAGES, type Actor } from "./AccessEditor";
import { calendarRoleLabel, canManageCalendarAccess, checkCalendarGrant, type CalendarRoleName } from "./calendar-roles";

export interface CalendarAccessUser {
  id: string;
  email: string | null;
  displayName: string;
  isActive: boolean;
  calendarRole: CalendarRoleName | null;
  organizationKeys: string[];
}

/** The fields of Core's OrgRecord this screen reads. */
export interface OrgOption {
  key: string;
  displayName: string;
  abbreviation: string | null;
  isActive: boolean;
  isHq: boolean;
  isPublic: boolean;
}

/**
 * `/hub/calendar-access`: Calendar roles and ministries (spec addendum §4, §8.5). Open to
 * Core.Admin, Calendar.Administrator and Calendar.SysAdmin. The server decides every grant
 * (C125); this screen only offers what the server would allow, and shows its refusal otherwise.
 */
export function CalendarAccessScreen(): React.JSX.Element {
  const session = useSession();
  useDocumentTitle("Calendar access");
  const allowed = canManageCalendarAccess(session);
  const [users, setUsers] = useState<CalendarAccessUser[] | null>(null);
  const [orgs, setOrgs] = useState<OrgOption[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [showInactive, setShowInactive] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const latest = useRef(0);

  const reload = useCallback(() => {
    const call = ++latest.current;
    Promise.all([apiFetch<CalendarAccessUser[]>("/core/api/calendar-access"), apiFetch<OrgOption[]>("/core/api/organizations")]).then(
      ([u, o]) => {
        if (call !== latest.current) return;
        setUsers(u);
        setOrgs(o);
        setLoadError(null);
      },
      () => {
        if (call === latest.current) setLoadError("Couldn't load Calendar access.");
      },
    );
  }, []);

  useEffect(() => {
    if (allowed) reload();
  }, [allowed, reload]);

  if (!allowed) {
    return (
      <div className="gcpe-calendar-access">
        <h1>Calendar access</h1>
        <p>You don&rsquo;t have permission to view this page.</p>
      </div>
    );
  }

  const byKey = new Map(orgs.map((o) => [o.key, o]));
  const needle = filter.trim().toLowerCase();
  const shown = (users ?? []).filter((u) => (showInactive || u.isActive) && (!needle || u.displayName.toLowerCase().includes(needle) || (u.email ?? "").includes(needle)));
  const hqKeys = new Set(orgs.filter((o) => o.isHq).map((o) => o.key));
  const actor: Actor = actorFor(session, users ?? [], orgs);

  return (
    <div className="gcpe-calendar-access">
      <h1>Calendar access</h1>
      <p>Give staff a Calendar role and their ministries. Members of an HQ organization see every ministry.</p>
      {loadError && <InlineAlert variant="danger" role="alert" description={loadError} />}
      {status && <p role="status">{status}</p>}
      <TextField label="Find a user by name or email" value={filter} onChange={setFilter} />
      <div>
        <input id="calendar-access-show-inactive" type="checkbox" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} />
        <label htmlFor="calendar-access-show-inactive">Show inactive users, including those with no email</label>
      </div>
      {users === null && !loadError && <p>Loading…</p>}
      <ul>
        {shown.map((u) => {
          const ministries = u.organizationKeys.map((k) => byKey.get(k)?.abbreviation ?? k).join(", ") || "none";
          // The same check the server makes, for a save that keeps the user's role and ministries.
          const refusal = checkCalendarGrant({
            actorId: actor.id,
            actorRoles: actor.roles,
            actorIsHq: actor.isHq,
            targetId: u.id,
            targetRole: u.calendarRole,
            nextRole: null,
            addsHqOrganization: false,
            targetHasHqAfter: u.organizationKeys.some((k) => hqKeys.has(k)),
          });
          const locked = refusal ? (LOCKED_MESSAGES[refusal] ?? "You can’t change this user’s access.") : null;
          return (
            <li key={u.id}>
              <h2>{u.displayName}</h2>
              <p>
                {u.email ?? "No email"}
                {u.isActive ? "" : " — inactive"}
              </p>
              <p>
                Calendar role: {u.calendarRole ? calendarRoleLabel(u.calendarRole) : "No Calendar access"}. Ministries: {ministries}.
              </p>
              {locked ? (
                <p>{locked}</p>
              ) : editing === u.id ? (
                <AccessEditor
                  user={u}
                  orgs={orgs}
                  actor={actor}
                  onSaved={(m) => {
                    setEditing(null);
                    setStatus(m);
                    reload();
                  }}
                  onCancel={() => setEditing(null)}
                />
              ) : (
                <Button
                  variant="secondary"
                  onPress={() => {
                    setStatus(null);
                    setEditing(u.id);
                  }}
                >
                  {`Edit access for ${u.displayName}`}
                </Button>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

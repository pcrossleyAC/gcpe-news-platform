import { useCallback, useEffect, useRef, useState } from "react";
import { Button, InlineAlert, TextField } from "@bcgov/design-system-react-components";
import { apiFetch } from "../../../api/client";
import { useSession } from "../../../session/SessionContext";
import { useDocumentTitle } from "../../../shared/useDocumentTitle";
import { messagesOf } from "../messages";
import { calendarRoleLabel, canManageCalendarAccess, ceilingLevel, grantableCalendarRoles, levelOf, type CalendarRoleName } from "./calendar-roles";

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
}

function orgLabel(o: OrgOption): string {
  return `${o.displayName}${o.abbreviation ? ` (${o.abbreviation})` : ""}${o.isHq ? " — HQ" : ""}${o.isActive ? "" : " — inactive"}`;
}

function AccessEditor({ user, orgs, onSaved, onCancel }: { user: CalendarAccessUser; orgs: OrgOption[]; onSaved(message: string): void; onCancel(): void }): React.JSX.Element {
  const session = useSession();
  const [role, setRole] = useState<CalendarRoleName | "">(user.calendarRole ?? "");
  const [keys, setKeys] = useState<string[]>(user.organizationKeys);
  const [messages, setMessages] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  // Inactive ministries can't be added, but one the user already holds stays offered so it can be kept.
  const choices = orgs.filter((o) => o.isActive || user.organizationKeys.includes(o.key));
  const toggle = (key: string) => setKeys((k) => (k.includes(key) ? k.filter((x) => x !== key) : [...k, key]));

  const save = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setBusy(true);
    setMessages([]);
    try {
      await apiFetch(`/core/api/calendar-access/${user.id}`, { method: "PUT", body: { role: role === "" ? null : role, organizationKeys: keys } });
      onSaved(`Saved Calendar access for ${user.displayName}.`);
    } catch (caught) {
      setMessages(messagesOf(caught));
    } finally {
      setBusy(false);
    }
  };

  const selectId = `calendar-role-${user.id}`;
  return (
    <form onSubmit={save} aria-label={`Calendar access for ${user.displayName}`}>
      {messages.map((m) => (
        <p role="alert" key={m}>
          {m}
        </p>
      ))}
      <label htmlFor={selectId}>Calendar role</label>
      <select id={selectId} value={role} onChange={(e) => setRole(e.target.value as CalendarRoleName | "")} disabled={busy}>
        <option value="">No Calendar access</option>
        {grantableCalendarRoles(session).map((r) => (
          <option key={r.role} value={r.role}>
            {r.label}
          </option>
        ))}
      </select>
      <fieldset>
        <legend>Ministries</legend>
        {choices.map((o) => {
          const id = `org-${user.id}-${o.key}`;
          return (
            <div key={o.key}>
              <input id={id} type="checkbox" checked={keys.includes(o.key)} onChange={() => toggle(o.key)} disabled={busy} />
              <label htmlFor={id}>{orgLabel(o)}</label>
            </div>
          );
        })}
      </fieldset>
      <Button type="submit" isDisabled={busy}>
        Save Calendar access
      </Button>
      <Button variant="secondary" onPress={onCancel} isDisabled={busy}>
        Cancel
      </Button>
    </form>
  );
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
  const ceiling = ceilingLevel(session);
  const isCoreAdmin = session.has("Core.Admin");

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
          const locked =
            !isCoreAdmin && session.user?.id === u.id
              ? "You can’t change your own Calendar access."
              : levelOf(u.calendarRole) > ceiling
                ? "Only a System Administrator or a Core admin can change this user’s access."
                : null;
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

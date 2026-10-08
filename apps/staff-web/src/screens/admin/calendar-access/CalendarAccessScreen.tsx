import { useCallback, useEffect, useRef, useState } from "react";
import { Button, InlineAlert, TextField } from "@bcgov/design-system-react-components";
import { ApiError, apiFetch } from "../../../api/client";
import { useSession } from "../../../session/SessionContext";
import { useDocumentTitle } from "../../../shared/useDocumentTitle";
import { messagesOf } from "../messages";
import { calendarRoleLabel, canManageCalendarAccess, canonicalId, checkCalendarGrant, grantableCalendarRoles, type CalendarGrantRefusal, type CalendarRoleName } from "./calendar-roles";

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

function orgLabel(o: OrgOption): string {
  return `${o.displayName}${o.abbreviation ? ` (${o.abbreviation})` : ""}${o.isHq ? " — HQ" : ""}${o.isActive ? "" : " — inactive"}`;
}

/** Why the screen won't open a user's editor, in the screen's words; the server sends its own on a refused save. */
const LOCKED_MESSAGES: Partial<Record<CalendarGrantRefusal, string>> = {
  "own-access": "You can’t change your own Calendar access.",
  "target-above-ceiling": "Only a System Administrator or a Core admin can change this user’s access.",
  "hq-target": "Only an HQ Administrator, a System Administrator or a Core admin can change this user’s access.",
};

/**
 * A 400 for unknown or inactive ministries names them in `keys`. Only keys this save submitted
 * are shown, so the message never repeats anything the user didn't type or pick.
 */
function saveMessages(caught: unknown, submitted: readonly string[]): string[] {
  const keys = caught instanceof ApiError && caught.status === 400 ? (caught.body as { keys?: unknown } | undefined)?.keys : undefined;
  if (!Array.isArray(keys)) return messagesOf(caught);
  const named = submitted.filter((k) => keys.includes(k));
  return named.length ? [`${(caught as ApiError).message}: ${named.join(", ")}`] : messagesOf(caught);
}

/** What checkCalendarGrant needs about the actor, worked out from the session and the actor's own row. */
interface Actor {
  id: string;
  roles: readonly string[];
  isHq: boolean;
}

function AccessEditor({ user, orgs, actor, onSaved, onCancel }: { user: CalendarAccessUser; orgs: OrgOption[]; actor: Actor; onSaved(message: string): void; onCancel(): void }): React.JSX.Element {
  const session = useSession();
  const [role, setRole] = useState<CalendarRoleName | "">(user.calendarRole ?? "");
  const [keys, setKeys] = useState<string[]>(user.organizationKeys);
  const [messages, setMessages] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  // An HQ ministry is offered only when the server would let this actor add it (C125).
  const mayAddHq =
    checkCalendarGrant({
      actorId: actor.id,
      actorRoles: actor.roles,
      actorIsHq: actor.isHq,
      targetId: user.id,
      targetRole: user.calendarRole,
      nextRole: null,
      addsHqOrganization: true,
      targetHasHqAfter: true,
    }) === null;
  // Inactive ministries can't be added, but one the user already holds stays offered so it can be kept.
  const choices = orgs.filter((o) => (o.isActive || user.organizationKeys.includes(o.key)) && (!o.isHq || mayAddHq || user.organizationKeys.includes(o.key)));
  const toggle = (key: string) => setKeys((k) => (k.includes(key) ? k.filter((x) => x !== key) : [...k, key]));

  const save = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setBusy(true);
    setMessages([]);
    try {
      await apiFetch(`/core/api/calendar-access/${user.id}`, { method: "PUT", body: { role: role === "" ? null : role, organizationKeys: keys } });
      onSaved(`Saved Calendar access for ${user.displayName}.`);
    } catch (caught) {
      setMessages(saveMessages(caught, keys));
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
  const hqKeys = new Set(orgs.filter((o) => o.isHq).map((o) => o.key));
  const sessionId = session.user ? canonicalId(session.user.id) : "";
  const ownRow = (users ?? []).find((u) => canonicalId(u.id) === sessionId);
  // The server reads the actor's HQ membership from their own user record; with no row (break-glass) it is never HQ.
  const actor: Actor = { id: session.user?.id ?? "", roles: session.roles, isHq: !!ownRow?.organizationKeys.some((k) => hqKeys.has(k)) };

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

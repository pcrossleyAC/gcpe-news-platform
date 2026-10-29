import { Fragment, useCallback, useEffect, useState } from "react";
import { AlertDialog, InlineAlert, Modal, Switch, TextField } from "@bcgov/design-system-react-components";
import { apiFetch } from "../../../api/client";
import { useSession } from "../../../session/SessionContext";
import { Button } from "../../../shared/BusyButton";
import { ignoreWhileBusy } from "../../../shared/guardSubmit";
import { useDocumentTitle } from "../../../shared/useDocumentTitle";
import { HiddenPrefixLabel, ShortLabel } from "../../../shared/ShortLabel";
import { messagesOf } from "../messages";
import { useSeededValue } from "../../../shared/useSeededValue";
import { afterDialogsClose } from "../../../shared/afterDialogsClose";
import { STAFF_ROLES } from "./roles";
import { TableScroll } from "../../../shared/TableScroll";
import { Link } from "react-router";
import { calendarRoleLabel } from "../calendar-access/calendar-roles";
import type { CalendarAccessUser, OrgOption } from "../calendar-access/CalendarAccessScreen";

/** Each user's Calendar role and ministries, as Calendar access keeps them: "Editor (HLTH)". */
type CalendarLines = ReadonlyMap<string, string>;

function calendarLines(access: CalendarAccessUser[], orgs: OrgOption[]): CalendarLines {
  const abbr = new Map(orgs.map((o) => [o.key, o.abbreviation ?? o.displayName]));
  const lines = new Map<string, string>();
  for (const u of access) {
    if (!u.calendarRole) continue;
    const ministries = u.organizationKeys.map((k) => abbr.get(k) ?? k).join(", ");
    lines.set(u.id, `${calendarRoleLabel(u.calendarRole)}${ministries ? ` (${ministries})` : ""}`);
  }
  return lines;
}

export interface UserView {
  id: string;
  email: string | null;
  displayName: string;
  isActive: boolean;
  signInMethod: "local" | "entra";
  roles: string[];
}

function RoleCheckboxes({ selected, onChange, idPrefix, disabled }: { selected: string[]; onChange(next: string[]): void; idPrefix: string; disabled: boolean }): React.JSX.Element {
  const toggle = (role: string) => onChange(selected.includes(role) ? selected.filter((r) => r !== role) : [...selected, role]);
  return (
    <fieldset className="gcpe-options gcpe-options--stacked">
      <legend>Roles</legend>
      {STAFF_ROLES.map(({ role, description }) => (
        <label key={role} htmlFor={`${idPrefix}-${role}`}>
          <input id={`${idPrefix}-${role}`} type="checkbox" checked={selected.includes(role)} onChange={() => toggle(role)} disabled={disabled} />
          <span>
            <strong>{role}</strong> — {description}
          </span>
        </label>
      ))}
    </fieldset>
  );
}

function UserEditor({ user, onChanged, id }: { user: UserView; onChanged(): void; id: string }): React.JSX.Element {
  // Seeded from the server's copy: after a save (or any other change) reloads the list, an
  // untouched field follows the new value instead of keeping the old one.
  const { value: displayName, setValue: setDisplayName } = useSeededValue(user.displayName);
  const { value: roles, setValue: setRoles } = useSeededValue(user.roles);
  const [password, setPassword] = useState("");
  const [nameMessages, setNameMessages] = useState<string[]>([]);
  const [activeMessages, setActiveMessages] = useState<string[]>([]);
  const [rolesMessages, setRolesMessages] = useState<string[]>([]);
  const [passwordMessages, setPasswordMessages] = useState<string[]>([]);
  const [passwordSaved, setPasswordSaved] = useState(false);
  const [unlinkMessages, setUnlinkMessages] = useState<string[]>([]);
  const [confirmingUnlink, setConfirmingUnlink] = useState(false);
  // Switching Active off asks first (owner decision 2026-10-29); switching it on is instant.
  const [confirmingDeactivate, setConfirmingDeactivate] = useState(false);
  const [activeSaved, setActiveSaved] = useState(false);
  const [busy, setBusy] = useState(false);

  const saveName = async () => {
    setBusy(true);
    setNameMessages([]);
    try {
      await apiFetch<UserView>(`/core/api/users/${user.id}`, { method: "PATCH", body: { displayName } });
      onChanged();
    } catch (caught) {
      setNameMessages(messagesOf(caught));
    } finally {
      setBusy(false);
    }
  };

  const toggleActive = async (next: boolean) => {
    setBusy(true);
    setActiveMessages([]);
    setActiveSaved(false);
    try {
      await apiFetch<UserView>(`/core/api/users/${user.id}`, { method: "PATCH", body: { isActive: next } });
      onChanged();
      // Shown (and so announced) only once the Deactivate dialog has fully closed.
      afterDialogsClose(() => setActiveSaved(true));
    } catch (caught) {
      const messages = messagesOf(caught);
      afterDialogsClose(() => setActiveMessages(messages));
    } finally {
      setBusy(false);
      setConfirmingDeactivate(false);
    }
  };

  const saveRoles = async () => {
    setBusy(true);
    setRolesMessages([]);
    try {
      await apiFetch<UserView>(`/core/api/users/${user.id}/roles`, { method: "PUT", body: { roles } });
      onChanged();
    } catch (caught) {
      setRolesMessages(messagesOf(caught));
    } finally {
      setBusy(false);
    }
  };

  const savePassword = async (e: React.FormEvent<HTMLFormElement>) => {
    if (ignoreWhileBusy(busy, e)) return;
    setBusy(true);
    setPasswordMessages([]);
    setPasswordSaved(false);
    const toSend = password;
    setPassword(""); // never kept around once submitted, success or not
    try {
      await apiFetch(`/core/api/users/${user.id}/password`, { method: "POST", body: { password: toSend } });
      // Minors: nothing on screen used to change on success — the password field just went
      // blank again, indistinguishable from a failed save that also cleared it.
      setPasswordSaved(true);
    } catch (caught) {
      setPasswordMessages(messagesOf(caught));
    } finally {
      setBusy(false);
    }
  };

  const unlink = async () => {
    setConfirmingUnlink(false);
    setBusy(true);
    setUnlinkMessages([]);
    try {
      await apiFetch<UserView>(`/core/api/users/${user.id}/unlink-entra`, { method: "POST" });
      onChanged();
    } catch (caught) {
      setUnlinkMessages(messagesOf(caught));
    } finally {
      setBusy(false);
    }
  };

  const who = user.email ?? `${user.displayName} (no email)`;

  return (
    <div className="gcpe-users__editor" id={id}>
      <h3 className="gcpe-users__who">
        {who} {!user.isActive && "(inactive)"}
      </h3>
      <p className="gcpe-users__sign-in">Sign-in: {user.signInMethod === "local" ? "Local password" : "Microsoft (Entra)"}</p>
      {user.signInMethod === "entra" && (
        <>
          {unlinkMessages.map((m) => (
            <p role="alert" key={m}>
              {m}
            </p>
          ))}
          <p>Unlinking returns this user to password sign-in; any password they had before works again. Their next Microsoft sign-in links them again by email.</p>
          <Button variant="secondary" onPress={() => setConfirmingUnlink(true)} isPending={busy} aria-label={`Unlink ${who} from Microsoft sign-in`}>
            Unlink Microsoft sign-in
          </Button>
          <Modal isOpen={confirmingUnlink} onOpenChange={(open) => { if (!open) setConfirmingUnlink(false); }} isDismissable>
            <AlertDialog
              role="alertdialog"
              aria-label={`Unlink ${who} from Microsoft sign-in`}
              variant="warning"
              title="Unlink Microsoft sign-in?"
              buttons={
                <>
                  <Button onPress={() => setConfirmingUnlink(false)}>Cancel</Button>
                  <Button danger isPending={busy} onPress={() => void unlink()}>
                    Unlink
                  </Button>
                </>
              }
            >
              <p>{who} will sign in with a password instead, if one was set before. Their next Microsoft sign-in links them again by email.</p>
            </AlertDialog>
          </Modal>
        </>
      )}

      {nameMessages.map((m) => (
        <p role="alert" key={m}>
          {m}
        </p>
      ))}
      <div className="gcpe-field-row">
        {/* TextField types `label` as a string, but renders it as the label's content. */}
        <TextField label={(<HiddenPrefixLabel prefix={who} text="display name" />) as unknown as string} value={displayName} onChange={setDisplayName} isReadOnly={busy} />
        <Button variant="secondary" onPress={() => void saveName()} isPending={busy}>
          Save name
        </Button>
      </div>

      {activeMessages.map((m) => (
        <p role="alert" key={m}>
          {m}
        </p>
      ))}
      {user.email === null ? (
        <>
          <p>Inactive until linked to an email.</p>
          <LinkForm user={user} onChanged={onChanged} />
        </>
      ) : (
        <div className="gcpe-inline-control">
          <Switch
            isSelected={user.isActive}
            isReadOnly={busy}
            onChange={(v) => {
              setActiveSaved(false);
              if (v) void toggleActive(true);
              else setConfirmingDeactivate(true);
            }}
          >
            <ShortLabel short="Active" full={`${who} is ${user.isActive ? "active" : "inactive"}`} />
          </Switch>
          {/* Always rendered, so the "Saved" that appears in it is announced. */}
          <span aria-live="polite" className="gcpe-inline-note">
            {activeSaved ? "Saved" : ""}
          </span>
          <Modal isOpen={confirmingDeactivate} onOpenChange={(open) => { if (!open && !busy) setConfirmingDeactivate(false); }} isDismissable>
            <AlertDialog
              role="alertdialog"
              variant="warning"
              title={`Deactivate ${user.displayName}?`}
              buttons={
                <>
                  <Button variant="secondary" isPending={busy} onPress={() => setConfirmingDeactivate(false)}>
                    Cancel
                  </Button>
                  <Button danger isPending={busy} onPress={() => void toggleActive(false)}>
                    Deactivate
                  </Button>
                </>
              }
            >
              <p>They can&rsquo;t sign in until reactivated.</p>
            </AlertDialog>
          </Modal>
        </div>
      )}

      {rolesMessages.map((m) => (
        <p role="alert" key={m}>
          {m}
        </p>
      ))}
      <RoleCheckboxes selected={roles} onChange={setRoles} idPrefix={`roles-${user.id}`} disabled={busy} />
      <Button variant="secondary" onPress={() => void saveRoles()} isPending={busy}>
        Save roles
      </Button>

      {user.signInMethod === "local" && (
        <form onSubmit={savePassword} aria-label={`Set ${who}'s password`}>
          {passwordMessages.map((m) => (
            <p role="alert" key={m}>
              {m}
            </p>
          ))}
          {/* Minors: without this, the field just going blank again on success looked
           * identical to a failed save that also clears it. */}
          {passwordSaved && <p role="status">Password updated.</p>}
          <div className="gcpe-field-row">
            <TextField
              label={(<HiddenPrefixLabel prefix={who} text="new password" />) as unknown as string}
              type="password"
              value={password}
              onChange={(v) => {
                setPassword(v);
                setPasswordSaved(false);
              }}
              isReadOnly={busy}
              autoComplete="new-password"
            />
            <Button variant="secondary" type="submit" isPending={busy} isDisabled={password.length === 0}>
              Set password
            </Button>
          </div>
        </form>
      )}
    </div>
  );
}

const signInLabel = (u: UserView) => (u.signInMethod === "local" ? "Password" : "Microsoft");

/** The role's area and name, shortened for a badge ("NRMS.SiteEditor" → "NRMS Site editor"). */
const roleBadge = (role: string) => {
  const [area, name = ""] = role.split(".");
  return `${area} ${name.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/ (\w)/g, (_, c: string) => ` ${c.toLowerCase()}`)}`.trim();
};

/**
 * Every user as one table row (name, email, sign-in, roles, active), filtered as you type; Edit
 * opens that user's editor in a row underneath, with every field and save it always had.
 */
function UsersTable({ users, calendar, onChanged }: { users: UserView[]; calendar: CalendarLines; onChanged(): void }): React.JSX.Element {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  // Editors once opened stay mounted (hidden when closed or filtered out), so typed but unsaved
  // name, roles or password survive Close and the filter.
  const [mounted, setMounted] = useState<Set<string>>(() => new Set());
  const q = query.trim().toLowerCase();
  // Name, email and roles match on any part; the status only as a whole word, so "active"
  // never finds an inactive user.
  const matches = (u: UserView) =>
    !q || [u.displayName, u.email ?? "", ...u.roles, calendar.has(u.id) ? `Calendar ${calendar.get(u.id)}` : ""].some((t) => t.toLowerCase().includes(q)) || q === (u.isActive ? "active" : "inactive");
  const shownCount = users.filter(matches).length;
  // The count is announced once typing pauses, not on every keystroke.
  const [countText, setCountText] = useState(`${users.length} users`);
  const nextCount = q ? `Showing ${shownCount} of ${users.length} users` : `${users.length} users`;
  useEffect(() => {
    const t = setTimeout(() => setCountText(nextCount), 500);
    return () => clearTimeout(t);
  }, [nextCount]);
  const toggle = (id: string) => {
    setMounted((prev) => new Set(prev).add(id));
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <>
      <div className="gcpe-users__filter">
        <TextField label="Filter users" description="By name, email or role" type="search" value={query} onChange={setQuery} />
        <p aria-live="polite" className="gcpe-users__count">
          {countText}
        </p>
      </div>
      <TableScroll label="Staff users">
        <table className="gcpe-table gcpe-users__table">
          <caption className="gcpe-visually-hidden">Staff users</caption>
          <thead>
            <tr>
              <th scope="col">Name</th>
              <th scope="col">Email</th>
              <th scope="col">Sign-in</th>
              <th scope="col">Roles</th>
              <th scope="col">Status</th>
              <th scope="col">
                <span className="gcpe-visually-hidden">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {shownCount === 0 && (
              <tr>
                <td colSpan={6}>No users match &ldquo;{query.trim()}&rdquo;.</td>
              </tr>
            )}
            {users.map((u) => {
              const who = u.email ?? `${u.displayName} (no email)`;
              const visible = matches(u);
              const isOpen = visible && open.has(u.id);
              const editorId = `user-editor-${u.id}`;
              return (
                <Fragment key={u.id}>
                  <tr className={isOpen ? "gcpe-users__open" : undefined} hidden={!visible}>
                    <th scope="row">{u.displayName}</th>
                    <td className="gcpe-users__email">{u.email ?? <span className="gcpe-hint">No email</span>}</td>
                    <td>{signInLabel(u)}</td>
                    <td>
                      {u.roles.length === 0 && !calendar.has(u.id) && <span className="gcpe-hint">None</span>}
                      {u.roles.length > 0 && (
                        <ul className="gcpe-badge-list">
                          {u.roles.map((r) => (
                            <li key={r} className="gcpe-badge" title={r}>
                              {roleBadge(r)}
                            </li>
                          ))}
                        </ul>
                      )}
                      {/* Calendar roles live in Calendar access; shown here read-only, with the way there. */}
                      {calendar.has(u.id) && (
                        <p className="gcpe-users__calendar">
                          {`Calendar: ${calendar.get(u.id)}`} <span aria-hidden="true">·</span> <Link to="/calendar-access">manage in Calendar access</Link>
                        </p>
                      )}
                    </td>
                    <td>{u.isActive ? "Active" : <span className="gcpe-badge gcpe-badge--alert">Inactive</span>}</td>
                    <td>
                      <Button size="small" variant="secondary" aria-expanded={isOpen} aria-controls={isOpen ? editorId : undefined} onPress={() => toggle(u.id)}>
                        <span>
                          {isOpen ? "Close" : "Edit"} <span className="gcpe-visually-hidden">{who}</span>
                        </span>
                      </Button>
                    </td>
                  </tr>
                  {mounted.has(u.id) && (
                    <tr className="gcpe-users__editor-row" hidden={!isOpen}>
                      <td colSpan={6}>
                        <UserEditor id={editorId} user={u} onChanged={onChanged} />
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </TableScroll>
    </>
  );
}

/** Legacy Calendar users imported with no email (spec addendum §4) can't sign in until linked. */
function LinkForm({ user, onChanged }: { user: UserView; onChanged(): void }): React.JSX.Element {
  const [email, setEmail] = useState("");
  const [messages, setMessages] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent<HTMLFormElement>) => {
    if (ignoreWhileBusy(busy, e)) return;
    setBusy(true);
    setMessages([]);
    try {
      await apiFetch<UserView>(`/core/api/users/${user.id}/link`, { method: "POST", body: { email } });
      onChanged();
    } catch (caught) {
      setMessages(messagesOf(caught));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form onSubmit={submit} aria-label={`Link ${user.displayName} to an email`}>
      {messages.map((m) => (
        <p role="alert" key={m}>
          {m}
        </p>
      ))}
      <p>Linking sets this user&rsquo;s email and activates them, so they can sign in.</p>
      <TextField label={`Email for ${user.displayName}`} type="email" value={email} onChange={setEmail} isRequired isReadOnly={busy} />
      <Button type="submit" isPending={busy} isDisabled={email.trim() === ""} pendingLabel="Linking…">
        Link and activate
      </Button>
    </form>
  );
}

/**
 * `/hub/users` (task-5-brief.md): `Core.Admin`-only staff user management. Every write goes
 * straight to `/core/api/users/...` (no versioned-save/409 concern here — Core's users API has
 * no optimistic-concurrency version at all) and refetches the whole list on success, which is
 * simplest and always correct for a list this small.
 */
export function UsersScreen(): React.JSX.Element {
  const session = useSession();
  useDocumentTitle("Users");
  const [users, setUsers] = useState<UserView[] | null>(null);
  const [calendar, setCalendar] = useState<CalendarLines>(() => new Map());
  const [loadError, setLoadError] = useState<string | null>(null);

  const [email, setEmail] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [roles, setRoles] = useState<string[]>([]);
  const [setPasswordNow, setSetPasswordNow] = useState(false);
  const [password, setPassword] = useState("");
  const [createMessages, setCreateMessages] = useState<string[]>([]);
  const [creating, setCreating] = useState(false);

  const isAdmin = session.has("Core.Admin");

  const reload = useCallback(() => {
    apiFetch<UserView[]>("/core/api/users").then(setUsers, () => setLoadError("Couldn't load users."));
    // Read only, for the Roles column; if it can't load, the column just shows the staff roles.
    Promise.all([apiFetch<CalendarAccessUser[]>("/core/api/calendar-access"), apiFetch<OrgOption[]>("/core/api/organizations")]).then(
      ([access, orgs]) => setCalendar(calendarLines(access, orgs)),
      () => undefined,
    );
  }, []);

  // Never fetched for anyone who can't see this page — AppShell already hides the nav item;
  // this is the defense-in-depth check for a direct deep link (same as WebsiteScreen/ErrorLogScreen).
  useEffect(() => {
    if (isAdmin) reload();
  }, [isAdmin, reload]);

  if (!isAdmin) {
    return (
      <div className="gcpe-users">
        <h1>Users</h1>
        <p>You don&rsquo;t have permission to view this page.</p>
      </div>
    );
  }

  const onCreate = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setCreating(true);
    setCreateMessages([]);
    // Fix round 1, item 3: cleared immediately, success or failure — same rule savePassword
    // follows (a typed password is never kept around once submitted, so a failed create never
    // leaves it sitting in the form for a 400/409 to be displayed next to).
    const passwordToSend = setPasswordNow ? password : undefined;
    setPassword("");
    try {
      await apiFetch("/core/api/users", { method: "POST", body: { email, displayName, roles, ...(passwordToSend ? { password: passwordToSend } : {}) } });
      setEmail("");
      setDisplayName("");
      setRoles([]);
      setSetPasswordNow(false);
      reload();
    } catch (caught) {
      setCreateMessages(messagesOf(caught));
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="gcpe-users">
      <h1>Users</h1>
      {loadError && <InlineAlert variant="danger" role="alert" description={loadError} />}

      <h2>All users</h2>
      {users === null && !loadError && <p>Loading…</p>}
      {users && <UsersTable users={users} calendar={calendar} onChanged={reload} />}

      <section className="gcpe-card" aria-labelledby="add-user-heading">
      <h2 id="add-user-heading">Add a user</h2>
      <form onSubmit={onCreate} aria-label="Add a user" className="gcpe-stack">
        {createMessages.map((m) => (
          <p role="alert" key={m}>
            {m}
          </p>
        ))}
        <TextField label="Email" type="email" value={email} onChange={setEmail} isRequired isReadOnly={creating} />
        <TextField label="Display name" value={displayName} onChange={setDisplayName} isRequired isReadOnly={creating} />
        <RoleCheckboxes selected={roles} onChange={setRoles} idPrefix="create-roles" disabled={creating} />
        <label className="gcpe-check">
          <input type="checkbox" checked={setPasswordNow} onChange={(e) => setSetPasswordNow(e.target.checked)} disabled={creating} />
          Set a password now
        </label>
        {setPasswordNow && (
          <TextField label="Password (at least 12 characters)" type="password" value={password} onChange={setPassword} isReadOnly={creating} autoComplete="new-password" />
        )}
        <Button type="submit" isPending={creating} pendingLabel="Adding…">
          Add user
        </Button>
      </form>
      </section>

    </div>
  );
}

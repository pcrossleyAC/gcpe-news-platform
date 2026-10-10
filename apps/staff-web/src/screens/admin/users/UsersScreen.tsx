import { useCallback, useEffect, useState } from "react";
import { Button, InlineAlert, Switch, TextField } from "@bcgov/design-system-react-components";
import { apiFetch } from "../../../api/client";
import { useSession } from "../../../session/SessionContext";
import { useDocumentTitle } from "../../../shared/useDocumentTitle";
import { messagesOf } from "../messages";
import { STAFF_ROLES } from "./roles";

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
    <fieldset>
      <legend>Roles</legend>
      {STAFF_ROLES.map(({ role, description }) => (
        <label key={role} htmlFor={`${idPrefix}-${role}`}>
          <input id={`${idPrefix}-${role}`} type="checkbox" checked={selected.includes(role)} onChange={() => toggle(role)} disabled={disabled} />
          {role} — {description}
        </label>
      ))}
    </fieldset>
  );
}

function UserRow({ user, onChanged }: { user: UserView; onChanged(): void }): React.JSX.Element {
  const [displayName, setDisplayName] = useState(user.displayName);
  const [roles, setRoles] = useState(user.roles);
  const [password, setPassword] = useState("");
  const [nameMessages, setNameMessages] = useState<string[]>([]);
  const [activeMessages, setActiveMessages] = useState<string[]>([]);
  const [rolesMessages, setRolesMessages] = useState<string[]>([]);
  const [passwordMessages, setPasswordMessages] = useState<string[]>([]);
  const [passwordSaved, setPasswordSaved] = useState(false);
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
    try {
      await apiFetch<UserView>(`/core/api/users/${user.id}`, { method: "PATCH", body: { isActive: next } });
      onChanged();
    } catch (caught) {
      setActiveMessages(messagesOf(caught));
    } finally {
      setBusy(false);
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
    e.preventDefault();
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

  const who = user.email ?? `${user.displayName} (no email)`;

  return (
    <li className="gcpe-users__row">
      <h2>
        {who} {!user.isActive && "(inactive)"}
      </h2>
      <p>Sign-in: {user.signInMethod === "local" ? "Local password" : "Entra"}</p>

      {nameMessages.map((m) => (
        <p role="alert" key={m}>
          {m}
        </p>
      ))}
      <TextField label={`${who} display name`} value={displayName} onChange={setDisplayName} isDisabled={busy} />
      <Button onPress={() => void saveName()} isDisabled={busy}>
        Save name
      </Button>

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
        <Switch isSelected={user.isActive} isDisabled={busy} onChange={(v) => void toggleActive(v)}>
          {who} is {user.isActive ? "active" : "inactive"}
        </Switch>
      )}

      {rolesMessages.map((m) => (
        <p role="alert" key={m}>
          {m}
        </p>
      ))}
      <RoleCheckboxes selected={roles} onChange={setRoles} idPrefix={`roles-${user.id}`} disabled={busy} />
      <Button onPress={() => void saveRoles()} isDisabled={busy}>
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
          <TextField
            label={`${who} new password`}
            type="password"
            value={password}
            onChange={(v) => {
              setPassword(v);
              setPasswordSaved(false);
            }}
            isDisabled={busy}
            autoComplete="new-password"
          />
          <Button type="submit" isDisabled={busy || password.length === 0}>
            Set password
          </Button>
        </form>
      )}
    </li>
  );
}

/** Legacy Calendar users imported with no email (spec addendum §4) can't sign in until linked. */
function LinkForm({ user, onChanged }: { user: UserView; onChanged(): void }): React.JSX.Element {
  const [email, setEmail] = useState("");
  const [messages, setMessages] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
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
      <TextField label={`Email for ${user.displayName}`} type="email" value={email} onChange={setEmail} isRequired isDisabled={busy} />
      <Button type="submit" isDisabled={busy || email.trim() === ""}>
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

      <h2>Add a user</h2>
      <form onSubmit={onCreate} aria-label="Add a user">
        {createMessages.map((m) => (
          <p role="alert" key={m}>
            {m}
          </p>
        ))}
        <TextField label="Email" type="email" value={email} onChange={setEmail} isRequired isDisabled={creating} />
        <TextField label="Display name" value={displayName} onChange={setDisplayName} isRequired isDisabled={creating} />
        <RoleCheckboxes selected={roles} onChange={setRoles} idPrefix="create-roles" disabled={creating} />
        <label>
          <input type="checkbox" checked={setPasswordNow} onChange={(e) => setSetPasswordNow(e.target.checked)} disabled={creating} />
          Set a password now
        </label>
        {setPasswordNow && (
          <TextField label="Password (at least 12 characters)" type="password" value={password} onChange={setPassword} isDisabled={creating} autoComplete="new-password" />
        )}
        <Button type="submit" isDisabled={creating}>
          Add user
        </Button>
      </form>

      <h2>All users</h2>
      {users === null && !loadError && <p>Loading…</p>}
      <ul>{users?.map((u) => <UserRow key={u.id} user={u} onChanged={reload} />)}</ul>
    </div>
  );
}

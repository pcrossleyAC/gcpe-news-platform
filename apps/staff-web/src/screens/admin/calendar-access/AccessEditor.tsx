import { useState } from "react";
import { Button } from "@bcgov/design-system-react-components";
import { ApiError, apiFetch } from "../../../api/client";
import { useSession } from "../../../session/SessionContext";
import { messagesOf } from "../messages";
import { canonicalId, checkCalendarGrant, grantableCalendarRoles, type CalendarGrantRefusal, type CalendarRoleName } from "./calendar-roles";
import type { CalendarAccessUser, OrgOption } from "./CalendarAccessScreen";

export function orgLabel(o: OrgOption): string {
  return `${o.displayName}${o.abbreviation ? ` (${o.abbreviation})` : ""}${o.isHq ? " — HQ" : ""}${o.isActive ? "" : " — inactive"}`;
}

/** Why the screen won't open a user's editor, in the screen's words; the server sends its own on a refused save. */
export const LOCKED_MESSAGES: Partial<Record<CalendarGrantRefusal, string>> = {
  "own-access": "You can’t change your own Calendar access.",
  "target-above-ceiling": "Only a System Administrator or a Core admin can change this user’s access.",
  "hq-target": "Only an HQ Administrator, a System Administrator or a Core admin can change this user’s access.",
};

/**
 * Why the screen won't open the editor for a user, if it won't: the server's checkCalendarGrant
 * refusal for a save that keeps the user's role, or the rule that only a Core admin may give
 * Calendar access to an inactive user who has none (the NRMS importer's shape).
 */
export function lockedMessage(refusal: CalendarGrantRefusal | null, actor: Actor, user: Pick<CalendarAccessUser, "isActive" | "calendarRole">): string | null {
  if (refusal) return LOCKED_MESSAGES[refusal] ?? "You can’t change this user’s access.";
  if (!actor.roles.includes("Core.Admin") && !user.isActive && user.calendarRole === null) return "Only a Core admin can give Calendar access to an inactive user who has none.";
  return null;
}

/**
 * A 400 for unknown or inactive ministries names them in `keys`. Only keys this save submitted
 * are shown, so the message never repeats anything the user didn't type or pick.
 */
export function saveMessages(caught: unknown, submitted: readonly string[]): string[] {
  const keys = caught instanceof ApiError && caught.status === 400 ? (caught.body as { keys?: unknown } | undefined)?.keys : undefined;
  if (!Array.isArray(keys)) return messagesOf(caught);
  const named = submitted.filter((k) => keys.includes(k));
  return named.length ? [`${(caught as ApiError).message}: ${named.join(", ")}`] : messagesOf(caught);
}

/** What checkCalendarGrant needs about the actor, worked out from the session and the actor's own row. */
export interface Actor {
  id: string;
  roles: readonly string[];
  isHq: boolean;
}

/** What checkCalendarGrant needs about the signed-in actor: their session roles, and HQ from their own row in Core's list (break-glass has none, so is never HQ). */
export function actorFor(session: { user: { id: string } | null; roles: readonly string[] }, users: readonly CalendarAccessUser[], orgs: readonly OrgOption[]): Actor {
  const hqKeys = new Set(orgs.filter((o) => o.isHq).map((o) => o.key));
  const own = users.find((u) => canonicalId(u.id) === canonicalId(session.user?.id ?? ""));
  return { id: session.user?.id ?? "", roles: session.roles, isHq: !!own?.organizationKeys.some((k) => hqKeys.has(k)) };
}

export function AccessEditor({ user, orgs, actor, onSaved, onCancel }: { user: CalendarAccessUser; orgs: OrgOption[]; actor: Actor; onSaved(message: string): void; onCancel(): void }): React.JSX.Element {
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
    <form onSubmit={save} aria-label={`Calendar access for ${user.displayName}`} className="gcpe-stack">
      {messages.map((m) => (
        <p role="alert" key={m}>
          {m}
        </p>
      ))}
      <div className="gcpe-field">
        <label htmlFor={selectId}>Calendar role</label>
        <select id={selectId} value={role} onChange={(e) => setRole(e.target.value as CalendarRoleName | "")} disabled={busy}>
          <option value="">No Calendar access</option>
          {grantableCalendarRoles(session).map((r) => (
            <option key={r.role} value={r.role}>
              {r.label}
            </option>
          ))}
        </select>
      </div>
      <fieldset className="gcpe-options">
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
      <div className="gcpe-button-row">
        <Button type="submit" isDisabled={busy}>
          Save Calendar access
        </Button>
        <Button variant="secondary" onPress={onCancel} isDisabled={busy}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

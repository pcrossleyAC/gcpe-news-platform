import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router";
import { InlineAlert } from "@bcgov/design-system-react-components";
import { ApiError, apiFetch } from "../../../api/client";
import { useSession } from "../../../session/SessionContext";
import { Button } from "../../../shared/BusyButton";
import { useFormShortcut } from "../../../shared/shortcuts";
import { useDocumentTitle } from "../../../shared/useDocumentTitle";
import { messagesOf } from "../../admin/messages";
import { AccessEditor, actorFor, lockedMessage } from "../../admin/calendar-access/AccessEditor";
import type { CalendarAccessUser, OrgOption } from "../../admin/calendar-access/CalendarAccessScreen";
import { canonicalId, checkCalendarGrant, type CalendarGrantRefusal } from "../../admin/calendar-access/calendar-roles";
import { RANK_OPTIONS, type CalendarUserDetail, type OpenActivities, type Profile } from "./types";

const LAG = "The Calendar picks this up within a minute.";
/** How often, and how many times (about 90 seconds), the page asks whether the Calendar has caught up with Core's ministries (suite review CAL-9). Tests shorten it. */
export const catchUp = { everyMs: 3_000, tries: 30 };

/** What the Account section does for this user: the verb in its button. */
type AccountAction = "deactivate" | "reactivate" | "link";

/**
 * Why Core would refuse this account change (services/calendar-access.ts's calendarAdminGuard), in
 * plain words: the reason shown instead of the button, and for the same refusal if it still comes back.
 */
const ACCOUNT_REFUSALS: Partial<Record<CalendarGrantRefusal | "other-roles" | "no-calendar-role", (verb: AccountAction) => string>> = {
  "other-roles": (v) => `Only a Core administrator can ${v} someone who also has other Hub roles.`,
  "no-calendar-role": (v) => `Only a Core administrator can ${v} someone who has no Calendar role.`,
  "hq-target": (v) => `Only an HQ Administrator, a System Administrator or a Core administrator can ${v} someone in an HQ organization.`,
  "target-above-ceiling": (v) => `Only a System Administrator or a Core administrator can ${v} a System Administrator.`,
  "own-access": (v) => `You can’t ${v} yourself.`,
};
const refusalText = (reason: unknown, verb: AccountAction): string | null =>
  typeof reason === "string" && Object.hasOwn(ACCOUNT_REFUSALS, reason) ? ACCOUNT_REFUSALS[reason as keyof typeof ACCOUNT_REFUSALS]!(verb) : null;

/** A server message in sentence case: "you can't deactivate yourself" ⇒ "You can't deactivate yourself." */
const sentence = (m: string) => {
  const t = m.trim();
  if (!t) return t;
  const s = t[0]!.toUpperCase() + t.slice(1);
  return /[.!?]$/.test(s) ? s : `${s}.`;
};

/** A refused account change in plain words: the reason's own sentence where Core sent one, otherwise its message in sentence case. */
function accountMessages(caught: unknown, verb: AccountAction): string[] {
  const reason = caught instanceof ApiError ? (caught.body as { reason?: unknown } | undefined)?.reason : undefined;
  const plain = refusalText(reason, verb);
  return plain ? [plain] : messagesOf(caught).map(sentence);
}

function Alerts({ messages }: { messages: string[] }): React.JSX.Element {
  return (
    <>
      {messages.map((m) => (
        <p role="alert" key={m}>
          {m}
        </p>
      ))}
    </>
  );
}

/** Its refusal shows beside the form only while `showMessages`: the page hides it once it shows a newer message. */
function ProfileForm({ userId, profile, onSaved, showMessages, onFailed }: { userId: string; profile: Profile; onSaved(msg: string): void; showMessages: boolean; onFailed(): void }): React.JSX.Element {
  const [draft, setDraft] = useState({ phone: profile.phone ?? "", mobile: profile.mobile ?? "", jobTitle: profile.jobTitle ?? "", description: profile.description ?? "" });
  const [messages, setMessages] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const field = (key: keyof typeof draft, label: string, hint?: string) => (
    <div>
      <label htmlFor={`profile-${key}`}>{label}</label>
      {hint && <p id={`profile-${key}-hint`}>{hint}</p>}
      <input id={`profile-${key}`} aria-describedby={hint ? `profile-${key}-hint` : undefined} value={draft[key]} onChange={(e) => setDraft({ ...draft, [key]: e.target.value })} disabled={busy} />
    </div>
  );
  const save = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setBusy(true);
    setMessages([]);
    try {
      await apiFetch(`/calendar/api/users/${userId}/profile`, { method: "PUT", body: draft });
      onSaved("Saved contact details.");
    } catch (caught) {
      setMessages(messagesOf(caught));
      onFailed();
    } finally {
      setBusy(false);
    }
  };
  // ⌘/Ctrl+S saves the contact details (the screen's Save) from anywhere on it.
  const formRef = useFormShortcut("save", !busy);
  return (
    <form ref={formRef} aria-label="Contact details" onSubmit={save}>
      <h2>Contact details</h2>
      <Alerts messages={showMessages ? messages : []} />
      {field("phone", "Phone", "Up to 20 characters")}
      {field("mobile", "Mobile", "12 digits and hyphens, like 250-555-0100")}
      {field("jobTitle", "Job title")}
      <div>
        <label htmlFor="profile-description">Description</label>
        <textarea id="profile-description" value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} disabled={busy} />
      </div>
      <Button type="submit" isPending={busy} pendingLabel="Saving…" shortcut="save">
        Save contact details
      </Button>
    </form>
  );
}

/** `/hub/calendar/users/:id`: one Calendar user (spec addendum §8.5). */
export function CalendarUserScreen(): React.JSX.Element {
  const { id = "" } = useParams();
  const session = useSession();
  const [detail, setDetail] = useState<CalendarUserDetail | null>(null);
  const [coreUsers, setCoreUsers] = useState<CalendarAccessUser[]>([]);
  const [orgs, setOrgs] = useState<OrgOption[]>([]);
  const [notFound, setNotFound] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [messages, setMessages] = useState<string[]>([]);
  const [editingAccess, setEditingAccess] = useState(false);
  const [linkEmail, setLinkEmail] = useState("");
  const [preview, setPreview] = useState<OpenActivities | null>(null);
  /** Whose message is on screen: one at a time, so a newer message never sits beside a stale one. */
  const [shown, setShown] = useState<"page" | "profile" | "access" | `rank:${string}` | null>(null);
  /** The last rank change's result, shown beside that ministry's select (it saves on change: form-order audit #17). */
  const [rankResult, setRankResult] = useState<{ ministryKey: string; ok: boolean; text: string } | null>(null);
  const latest = useRef(0);
  /** Reads made while the Calendar's ministries still differ from Core's; past catchUp.tries it stops asking. */
  const [catchUpTries, setCatchUpTries] = useState(0);
  useDocumentTitle(detail?.user.displayName ?? (notFound ? "Calendar user" : null));

  const reload = useCallback(() => {
    const call = ++latest.current;
    Promise.all([
      apiFetch<CalendarUserDetail>(`/calendar/api/users/${encodeURIComponent(id)}`),
      apiFetch<CalendarAccessUser[]>("/core/api/calendar-access"),
      apiFetch<OrgOption[]>("/core/api/organizations"),
    ]).then(
      ([d, u, o]) => {
        if (call !== latest.current) return;
        setDetail(d);
        setCoreUsers(u);
        setOrgs(o);
      },
      (caught: unknown) => {
        if (call !== latest.current) return;
        if (caught instanceof ApiError && caught.status === 404) setNotFound(true);
        else setLoadError("Couldn't load this user.");
      },
    );
  }, [id]);
  useEffect(() => reload(), [reload]);

  // Core's ministries are the authority; the Calendar's copy arrives about a minute later. While they
  // differ (ministries just given), ask again every few seconds, so the rank appears without a reload.
  const coreNow = detail ? coreUsers.find((c) => canonicalId(c.id) === canonicalId(detail.user.id)) : undefined;
  const sameKeys = (a: readonly string[], b: readonly string[]) => [...a].sort().join("\n") === [...b].sort().join("\n");
  const settingUp = !!detail && !!coreNow && !sameKeys(coreNow.organizationKeys, detail.user.ministryKeys);
  useEffect(() => {
    if (!settingUp || catchUpTries >= catchUp.tries) return;
    const t = setTimeout(() => {
      setCatchUpTries((n) => n + 1);
      reload();
    }, catchUp.everyMs);
    return () => clearTimeout(t);
  }, [settingUp, catchUpTries, detail, reload]);

  if (notFound) {
    return (
      <div>
        <h1>Calendar user</h1>
        <p>This user isn&rsquo;t in the Calendar.</p>
        <Link to="/calendar/users">All Calendar users</Link>
      </div>
    );
  }
  if (loadError) return <InlineAlert variant="danger" role="alert" description={loadError} />;
  if (!detail) return <p>Loading…</p>;

  const u = detail.user;
  // Core's view is the authority for role, ministries and active; the Calendar's copy can lag a tick.
  const core = coreUsers.find((c) => canonicalId(c.id) === canonicalId(u.id));
  const byKey = new Map(orgs.map((o) => [o.key, o]));
  const hqKeys = new Set(orgs.filter((o) => o.isHq).map((o) => o.key));
  const actor = actorFor(session, coreUsers, orgs);
  // The same check the server makes, for a save that keeps the target's role and ministries (C125).
  const refusal = core
    ? checkCalendarGrant({
        actorId: actor.id,
        actorRoles: actor.roles,
        actorIsHq: actor.isHq,
        targetId: core.id,
        targetRole: core.calendarRole,
        nextRole: null,
        addsHqOrganization: false,
        targetHasHqAfter: core.organizationKeys.some((k) => hqKeys.has(k)),
      })
    : null;
  const lockedAccess = core ? lockedMessage(refusal, actor, core) : null;
  const isActive = core?.isActive ?? u.isActive;
  const email = core ? core.email : u.email;
  const verb: AccountAction = isActive ? "deactivate" : email ? "reactivate" : "link";
  // What Core's calendarAdminGuard would refuse, so the button isn't offered for it. A Core admin may
  // change anyone's account; a user the Calendar knows but Core's list doesn't yet is left to the server.
  const accountRefusal = (() => {
    if (!core || actor.roles.includes("Core.Admin")) return null;
    if (core.calendarRole === null) return refusalText("no-calendar-role", verb);
    if (core.hasOtherRoles ?? false) return refusalText("other-roles", verb);
    const r = checkCalendarGrant({
      actorId: actor.id,
      actorRoles: actor.roles,
      actorIsHq: actor.isHq,
      targetId: core.id,
      targetRole: core.calendarRole,
      nextRole: core.calendarRole,
      addsHqOrganization: false,
      targetHasHqAfter: core.organizationKeys.some((k) => hqKeys.has(k)),
    });
    // The other refusals can't arise for a change that keeps the role; the server's own words cover them.
    return r ? (refusalText(r, verb) ?? `You can’t ${verb} this person.`) : null;
  })();
  // Whether the user works for a ministry the administrator doesn't: the page already shows their
  // ministries, so saying so reveals nothing. An HQ administrator sees every ministry's activities.
  const actorKeys = new Set(coreUsers.find((c) => canonicalId(c.id) === canonicalId(actor.id))?.organizationKeys ?? []);
  const otherMinistries = !actor.isHq && [...u.ministryKeys, ...detail.commContacts.map((c) => c.ministryKey)].some((k) => !actorKeys.has(k));
  const done = (msg: string) => {
    setStatus(msg);
    setMessages([]);
    setShown("page");
    reload();
  };
  const fail = (caught: unknown, toMessages: (caught: unknown) => string[] = messagesOf) => {
    setStatus(null);
    setMessages(toMessages(caught));
    setShown("page");
  };

  const setRank = async (ministryKey: string, label: string, value: string) => {
    const show = (r: { ok: boolean; text: string }) => {
      setRankResult({ ministryKey, ...r });
      setShown(`rank:${ministryKey}`);
    };
    try {
      await apiFetch(`/calendar/api/users/${u.id}/comm-contacts/${encodeURIComponent(ministryKey)}`, { method: "PUT", body: { rank: value === "" ? null : Number(value) } });
      const rank = RANK_OPTIONS.find((r) => r.value === value)?.label ?? value;
      show({ ok: true, text: `Saved: ${rank} for ${label}.` });
      reload();
    } catch (caught) {
      // The server's own reason when it gives one; otherwise a plain line.
      show({ ok: false, text: caught instanceof ApiError && caught.status < 500 ? messagesOf(caught).join(" ") : "The rank wasn't saved. Try again." });
    }
  };
  const showPreview = async () => {
    try {
      setPreview(await apiFetch<OpenActivities>(`/calendar/api/users/${u.id}/open-activities`));
    } catch (caught) {
      fail(caught);
    }
  };
  const setActive = async (isActive: boolean) => {
    try {
      await apiFetch(`/core/api/calendar-access/${u.id}/active`, { method: "PUT", body: { isActive } });
      done(`${u.displayName} is ${isActive ? "reactivated" : "deactivated"}. ${LAG}`);
    } catch (caught) {
      fail(caught, (c) => accountMessages(c, isActive ? "reactivate" : "deactivate"));
    }
  };
  const link = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    try {
      await apiFetch(`/core/api/calendar-access/${u.id}/link`, { method: "POST", body: { email: linkEmail } });
      done(`${u.displayName} is linked and active. ${LAG}`);
    } catch (caught) {
      fail(caught, (c) => accountMessages(c, "link"));
    }
  };

  // The server refuses anyone deactivating themself; the button isn't offered on their own page.
  const isSelf = canonicalId(u.id) === canonicalId(session.user?.id ?? "");
  return (
    <div>
      <p>
        <Link to="/calendar/users">All Calendar users</Link>
      </p>
      <h1>{u.displayName}</h1>
      <p>
        {email ?? "No email"}
        {isActive ? "" : " — inactive"}
      </p>
      {shown === "page" && status && <p role="status">{status}</p>}
      <Alerts messages={shown === "page" ? messages : []} />

      <h2>Calendar access</h2>
      {lockedAccess ? (
        <p>{lockedAccess}</p>
      ) : core && editingAccess ? (
        <AccessEditor
          user={core}
          orgs={orgs}
          actor={actor}
          onSaved={(m) => {
            setEditingAccess(false);
            done(`${m} ${LAG}`);
          }}
          onCancel={() => setEditingAccess(false)}
          showMessages={shown === "access"}
          onFailed={() => setShown("access")}
        />
      ) : (
        <Button variant="secondary" onPress={() => setEditingAccess(true)} isDisabled={!core}>
          {`Edit Calendar access for ${u.displayName}`}
        </Button>
      )}

      <ProfileForm userId={u.id} profile={detail.profile} onSaved={done} showMessages={shown === "profile"} onFailed={() => setShown("profile")} />

      <h2>Comm contact</h2>
      {/* Mounted from the start, so a screen reader hears when the Calendar is still setting them up. */}
      <p role="status" className="gcpe-hint">
        {settingUp
          ? catchUpTries < catchUp.tries
            ? "Setting up their ministries in the Calendar… The rank appears here in a moment."
            : "The Calendar hasn't picked up their new ministries yet. Reload the page in a minute."
          : ""}
      </p>
      {u.ministryKeys.length === 0 && !settingUp && <p>Give this user a ministry under Calendar access (Edit Calendar access) first.</p>}
      {u.ministryKeys.map((k) => {
        const o = byKey.get(k);
        const label = `${o?.displayName ?? k}${o?.abbreviation ? ` (${o.abbreviation})` : ""}`;
        const current = detail.commContacts.find((c) => c.ministryKey === k && c.isActive);
        const result = shown === `rank:${k}` && rankResult?.ministryKey === k ? rankResult : null;
        return (
          <div key={k}>
            <label htmlFor={`rank-${k}`}>{`Comm contact rank for ${label}`}</label>
            <select
              id={`rank-${k}`}
              value={current?.rank ? String(current.rank) : ""}
              onChange={(e) => void setRank(k, label, e.target.value)}
              aria-describedby={result ? (result.ok ? `rank-${k}-result` : `rank-${k}-error`) : undefined}
            >
              {RANK_OPTIONS.map((r) => (
                <option key={r.value} value={r.value}>
                  {r.label}
                </option>
              ))}
            </select>
            {/* Mounted from the start, empty, so a screen reader hears the first Saved too (as the Hub's Announcer). */}
            <p id={`rank-${k}-result`} role="status" className="gcpe-hint">
              {result?.ok ? result.text : ""}
            </p>
            {result && !result.ok && (
              <p id={`rank-${k}-error`} role="alert">
                {result.text}
              </p>
            )}
          </div>
        );
      })}

      <h2>Account</h2>
      {isSelf ? null : accountRefusal ? (
        <p>{accountRefusal}</p>
      ) : isActive ? (
        <>
          <Button variant="secondary" onPress={() => void showPreview()}>{`Deactivate ${u.displayName}`}</Button>
          {preview && (
            <DeactivatePreview
              userId={u.id}
              name={u.displayName}
              preview={preview}
              otherMinistries={otherMinistries}
              onDeactivate={() => {
                setPreview(null);
                void setActive(false);
              }}
              onCancel={() => setPreview(null)}
            />
          )}
        </>
      ) : email ? (
        <Button variant="secondary" onPress={() => void setActive(true)}>{`Reactivate ${u.displayName}`}</Button>
      ) : (
        <form aria-label={`Link and activate ${u.displayName}`} onSubmit={link}>
          <p>This user was imported without an email. Linking sets their email and activates them.</p>
          <label htmlFor="link-email">Email</label>
          <input id="link-email" type="email" value={linkEmail} onChange={(e) => setLinkEmail(e.target.value)} required />
          <Button type="submit">Link and activate</Button>
        </form>
      )}
    </div>
  );
}

/**
 * Before deactivating: the open activities this administrator can see. Nothing about the rest, not
 * even a count (it would reveal confidential activities); when the user also works for ministries
 * the administrator doesn't, the preview says so and who can check them.
 */
function DeactivatePreview({ userId, name, preview, otherMinistries, onDeactivate, onCancel }: {
  /** Transfer opens with this user's comm contact as From (form-order audit #17). */
  userId: string;
  name: string;
  preview: OpenActivities;
  otherMinistries: boolean;
  onDeactivate(): void;
  onCancel(): void;
}): React.JSX.Element {
  const listed = preview.activities.length;
  return (
    <section aria-label={`Before deactivating ${name}`}>
      <h3>Open activities</h3>
      {listed === 0 ? (
        <p>{otherMinistries ? "No open activities in your ministries." : "No open activities."}</p>
      ) : (
        <>
          <p>{name} is the comm contact for these activities. Deactivating doesn&rsquo;t move them.</p>
          <ul>
            {preview.activities.map((a) => (
              <li key={a.id}>{`${a.reference} — ${a.title} — ${a.startDate ?? "no date"}`}</li>
            ))}
          </ul>
          {preview.truncated && <p>Only the first 500 are listed.</p>}
          <p>
            <Link to={`/calendar/transfer?user=${encodeURIComponent(userId)}`}>Transfer their activities first</Link>
          </p>
        </>
      )}
      {otherMinistries && <p>They also work for ministries you don&rsquo;t belong to. Ask an HQ Administrator to check and transfer their activities there.</p>}
      <Button variant="secondary" onPress={onDeactivate}>
        {listed === 0 ? "Deactivate" : "Deactivate anyway"}
      </Button>
      <Button variant="tertiary" onPress={onCancel}>
        Cancel
      </Button>
    </section>
  );
}

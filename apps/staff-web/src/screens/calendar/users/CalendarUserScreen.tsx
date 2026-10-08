import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router";
import { Button, InlineAlert } from "@bcgov/design-system-react-components";
import { ApiError, apiFetch } from "../../../api/client";
import { useSession } from "../../../session/SessionContext";
import { useDocumentTitle } from "../../../shared/useDocumentTitle";
import { messagesOf } from "../../admin/messages";
import { AccessEditor, actorFor, lockedMessage } from "../../admin/calendar-access/AccessEditor";
import type { CalendarAccessUser, OrgOption } from "../../admin/calendar-access/CalendarAccessScreen";
import { canonicalId, checkCalendarGrant } from "../../admin/calendar-access/calendar-roles";
import { RANK_OPTIONS, type CalendarUserDetail, type OpenActivities, type Profile } from "./types";

const LAG = "The Calendar picks this up within a minute.";

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

function ProfileForm({ userId, profile, onSaved }: { userId: string; profile: Profile; onSaved(msg: string): void }): React.JSX.Element {
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
    } finally {
      setBusy(false);
    }
  };
  return (
    <form aria-label="Contact details" onSubmit={save}>
      <h2>Contact details</h2>
      <Alerts messages={messages} />
      {field("phone", "Phone", "Up to 20 characters")}
      {field("mobile", "Mobile", "12 digits and hyphens, like 250-555-0100")}
      {field("jobTitle", "Job title")}
      <div>
        <label htmlFor="profile-description">Description</label>
        <textarea id="profile-description" value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} disabled={busy} />
      </div>
      <Button type="submit" isDisabled={busy}>
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
  const latest = useRef(0);
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
  const done = (msg: string) => {
    setStatus(msg);
    setMessages([]);
    reload();
  };
  const fail = (caught: unknown) => setMessages(messagesOf(caught));

  const setRank = async (ministryKey: string, value: string) => {
    try {
      await apiFetch(`/calendar/api/users/${u.id}/comm-contacts/${encodeURIComponent(ministryKey)}`, { method: "PUT", body: { rank: value === "" ? null : Number(value) } });
      done("Saved the comm-contact rank.");
    } catch (caught) {
      fail(caught);
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
      fail(caught);
    }
  };
  const link = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    try {
      await apiFetch(`/core/api/calendar-access/${u.id}/link`, { method: "POST", body: { email: linkEmail } });
      done(`${u.displayName} is linked and active. ${LAG}`);
    } catch (caught) {
      fail(caught);
    }
  };

  const isActive = core?.isActive ?? u.isActive;
  // The server refuses anyone deactivating themself; the button isn't offered on their own page.
  const isSelf = canonicalId(u.id) === canonicalId(session.user?.id ?? "");
  const email = core ? core.email : u.email;
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
      {status && <p role="status">{status}</p>}
      <Alerts messages={messages} />

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
        />
      ) : (
        <Button variant="secondary" onPress={() => setEditingAccess(true)} isDisabled={!core}>
          {`Edit Calendar access for ${u.displayName}`}
        </Button>
      )}

      <ProfileForm userId={u.id} profile={detail.profile} onSaved={done} />

      <h2>Comm contact</h2>
      {u.ministryKeys.length === 0 && <p>Give this user a ministry first.</p>}
      {u.ministryKeys.map((k) => {
        const o = byKey.get(k);
        const label = `${o?.displayName ?? k}${o?.abbreviation ? ` (${o.abbreviation})` : ""}`;
        const current = detail.commContacts.find((c) => c.ministryKey === k && c.isActive);
        return (
          <div key={k}>
            <label htmlFor={`rank-${k}`}>{`Comm contact rank for ${label}`}</label>
            <select id={`rank-${k}`} value={current?.rank ? String(current.rank) : ""} onChange={(e) => void setRank(k, e.target.value)}>
              {RANK_OPTIONS.map((r) => (
                <option key={r.value} value={r.value}>
                  {r.label}
                </option>
              ))}
            </select>
          </div>
        );
      })}

      <h2>Account</h2>
      {isActive ? (
        isSelf ? null : (
          <>
            <Button variant="secondary" onPress={() => void showPreview()}>{`Deactivate ${u.displayName}`}</Button>
            {preview && (
              <section aria-label={`Before deactivating ${u.displayName}`}>
                <h3>Open activities</h3>
                {preview.activities.length === 0 ? (
                  <p>No open activities.</p>
                ) : (
                  <>
                    <p>{u.displayName} is the comm contact for these activities. Deactivating doesn&rsquo;t move them.</p>
                    <ul>
                      {preview.activities.map((a) => (
                        <li key={a.id}>{`${a.reference} — ${a.title} — ${a.startDate ?? "no date"}`}</li>
                      ))}
                    </ul>
                    {preview.truncated && <p>Only the first 500 are listed.</p>}
                    <p>
                      <Link to="/calendar/transfer">Transfer their activities first</Link>
                    </p>
                  </>
                )}
                <Button
                  variant="secondary"
                  onPress={() => {
                    setPreview(null);
                    void setActive(false);
                  }}
                >
                  {preview.activities.length === 0 ? "Deactivate" : "Deactivate anyway"}
                </Button>
                <Button variant="tertiary" onPress={() => setPreview(null)}>
                  Cancel
                </Button>
              </section>
            )}
          </>
        )
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

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Link, useParams } from "react-router";
import { AlertDialog, Button, DialogTrigger, Form, InlineAlert, Modal, TextField } from "@bcgov/design-system-react-components";
import { apiFetch, ApiError } from "../../api/client";
import { formatWhen } from "../../format/dates";
import { useTenantTimeZone } from "../../format/tenantTimeZone";
import { useSession } from "../../session/SessionContext";
import { useDocumentTitle } from "../../shared/useDocumentTitle";
import { canEditSubscribers } from "./access";
import { ListPicker } from "./ListPicker";
import { STATUS_LABELS, timingLabel } from "./labels";
import type { ListOptions, SubscriberDetail } from "./types";

/** apps/nod/src/db/schema.ts's subscribers_source_check. */
const SOURCE_LABELS: Record<string, string> = {
  self: "Signed up themselves",
  admin: "Added by staff",
  "media-hub": "Media Hub contact",
  "manual-media": "Added to a media list by staff",
};

/** The address is capped at 150 characters server-side (subscribe/info.ts's subscriberEmailSchema). */
const MAX_EMAIL_LENGTH = 150;

/** 400 `issues` (zod) are a different shape from a plain `message` — same split as
 * UsersScreen.messagesOf. */
function messagesOf(caught: unknown): string[] {
  if (caught instanceof ApiError) {
    if (caught.issues?.length) return caught.issues.map((i) => (i as { message?: string }).message ?? "Invalid request.");
    return [caught.message];
  }
  return ["Something went wrong."];
}

function statusText(d: Pick<SubscriberDetail, "status" | "disabledReason">): string {
  const base = STATUS_LABELS[d.status];
  if (d.status !== "disabled" || !d.disabledReason) return base;
  return `${base} — ${d.disabledReason === "bounces" ? "after repeated bounces" : "by staff"}`;
}

/** Read-only wording for a Viewer: same information as the Editor's form, with no form
 * controls at all (not even disabled ones). */
function PreferencesView({ detail, options }: { detail: SubscriberDetail; options: ListOptions | null }): React.JSX.Element {
  const names = new Map<string, string>();
  for (const c of options?.categories ?? []) for (const l of c.lists) names.set(l.listKey, l.name);
  return (
    <div className="gcpe-subscriber__preferences">
      <h2>Preferences</h2>
      <p>{detail.allNews ? "All news" : timingLabel(detail)}</p>
      {!detail.allNews && (
        <ul>
          {detail.listKeys.map((k) => (
            <li key={k}>{names.get(k) ?? k}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

function PreferencesForm({ detail, options, onSaved }: { detail: SubscriberDetail; options: ListOptions | null; onSaved(): void }): React.JSX.Element {
  const [allNews, setAllNews] = useState(detail.allNews);
  const [listKeys, setListKeys] = useState(detail.listKeys);
  const [asItHappens, setAsItHappens] = useState(detail.asItHappens);
  const [digest, setDigest] = useState(detail.digest);
  const [messages, setMessages] = useState<string[]>([]);
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);

  // Reseeds whenever the server's own copy changes (every reload, including this form's own
  // successful save) — never while the staff member is mid-edit with no reload in between.
  useEffect(() => {
    setAllNews(detail.allNews);
    setListKeys(detail.listKeys);
    setAsItHappens(detail.asItHappens);
    setDigest(detail.digest);
  }, [detail]);

  const onSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setMessages([]);
    setSaved(false);
    setSaving(true);
    try {
      await apiFetch(`/nod/api/subscribers/${detail.id}/preferences`, { method: "PUT", body: { asItHappens, digest, allNews, listKeys } });
      setSaved(true);
      onSaved();
    } catch (caught) {
      setMessages(messagesOf(caught));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Form onSubmit={onSubmit} aria-label="Preferences" className="gcpe-subscriber__preferences">
      <h2>Preferences</h2>
      {messages.map((m) => (
        <p role="alert" key={m}>
          {m}
        </p>
      ))}
      {saved && <p role="status">Preferences saved.</p>}

      <label>
        <input
          type="checkbox"
          checked={asItHappens}
          onChange={(e) => {
            setAsItHappens(e.target.checked);
            setSaved(false);
          }}
          disabled={saving}
        />{" "}
        As it happens
      </label>
      <label>
        <input
          type="checkbox"
          checked={digest}
          onChange={(e) => {
            setDigest(e.target.checked);
            setSaved(false);
          }}
          disabled={saving}
        />{" "}
        Daily digest
      </label>

      <ListPicker
        categories={options?.categories ?? []}
        allNews={allNews}
        listKeys={listKeys}
        heldKeys={detail.listKeys}
        onChange={(next) => {
          setAllNews(next.allNews);
          setListKeys(next.listKeys);
          setSaved(false);
        }}
        disabled={saving}
      />

      <Button type="submit" isDisabled={saving}>
        Save preferences
      </Button>
    </Form>
  );
}

function StatusSection({ detail, onChanged }: { detail: SubscriberDetail; onChanged(): void }): React.JSX.Element {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [deactivateOpen, setDeactivateOpen] = useState(false);

  const postStatus = async (status: "active" | "disabled") => {
    setBusy(true);
    setError(null);
    try {
      await apiFetch(`/nod/api/subscribers/${detail.id}/status`, { method: "POST", body: { status } });
      setDeactivateOpen(false);
      onChanged();
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 409) {
        setError("This subscriber's status changed; reload.");
        onChanged();
      } else {
        setError(caught instanceof ApiError ? caught.message : "Something went wrong.");
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="gcpe-subscriber__status-actions">
      {error && <InlineAlert variant="danger" role="alert" description={error} />}
      {detail.status === "disabled" && (
        // Reversible and harmless (unlike Deactivate/Delete), so this posts at once with no
        // confirm dialog.
        <Button onPress={() => void postStatus("active")} isDisabled={busy}>
          Activate
        </Button>
      )}
      {detail.status === "active" && (
        <DialogTrigger isOpen={deactivateOpen} onOpenChange={setDeactivateOpen}>
          <Button variant="secondary" isDisabled={busy}>
            Deactivate
          </Button>
          <Modal isDismissable>
            <AlertDialog
              role="alertdialog"
              variant="warning"
              title="Deactivate this subscriber?"
              buttons={
                <>
                  <Button onPress={() => setDeactivateOpen(false)} isDisabled={busy}>
                    Cancel
                  </Button>
                  <Button danger onPress={() => void postStatus("disabled")} isDisabled={busy}>
                    Confirm deactivate
                  </Button>
                </>
              }
            >
              <p>They receive nothing until activated again. Their lists, including media lists, are kept.</p>
            </AlertDialog>
          </Modal>
        </DialogTrigger>
      )}
    </div>
  );
}

function ChangeEmailSection({ detail, onChanged }: { detail: SubscriberDetail; onChanged(): void }): React.JSX.Element {
  const [email, setEmail] = useState("");
  const [confirmEmail, setConfirmEmail] = useState("");
  const [messages, setMessages] = useState<string[]>([]);
  const [takenId, setTakenId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (detail.source === "media-hub") {
    return <p>This address comes from Media Hub.</p>;
  }

  const onSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setMessages([]);
    setTakenId(null);
    const a = email.trim().toLowerCase();
    const b = confirmEmail.trim().toLowerCase();
    if (a !== b) {
      setMessages(["The two email addresses don't match."]);
      return;
    }
    setBusy(true);
    try {
      await apiFetch(`/nod/api/subscribers/${detail.id}/email`, { method: "POST", body: { email: a } });
      setEmail("");
      setConfirmEmail("");
      onChanged();
    } catch (caught) {
      const body = caught instanceof ApiError && caught.status === 409 && caught.body && typeof caught.body === "object" ? (caught.body as { error?: unknown; id?: unknown }) : undefined;
      if (body?.error === "email-taken") {
        setMessages(["Another subscriber record already has that address."]);
        setTakenId(typeof body.id === "string" ? body.id : null);
      } else if (body?.error === "media-hub-managed") {
        setMessages(["This address comes from Media Hub."]);
      } else {
        setMessages(messagesOf(caught));
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <Form onSubmit={onSubmit} aria-label="Change email" className="gcpe-subscriber__change-email">
      <h2>Change email</h2>
      {messages.map((m) => (
        <p role="alert" key={m}>
          {m}
        </p>
      ))}
      {takenId && <Link to={`/subscribers/${takenId}`}>Open that record</Link>}
      <TextField label="New email" type="email" value={email} onChange={setEmail} isDisabled={busy} maxLength={MAX_EMAIL_LENGTH} />
      <TextField label="Confirm new email" type="email" value={confirmEmail} onChange={setConfirmEmail} isDisabled={busy} maxLength={MAX_EMAIL_LENGTH} />
      <Button type="submit" isDisabled={busy}>
        Change email
      </Button>
      <p>No confirmation email is sent. Links in emails already sent to the old address stop working.</p>
    </Form>
  );
}

function DeleteSection({ detail, onDeleted }: { detail: SubscriberDetail; onDeleted(): void }): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const confirmDelete = async () => {
    setBusy(true);
    setError(null);
    try {
      await apiFetch(`/nod/api/subscribers/${detail.id}`, { method: "DELETE" });
      setOpen(false);
      onDeleted();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <DialogTrigger isOpen={open} onOpenChange={setOpen}>
      <Button variant="secondary" danger isDisabled={busy}>
        Delete
      </Button>
      <Modal isDismissable>
        <AlertDialog
          role="alertdialog"
          variant="destructive"
          title="Delete this subscriber?"
          buttons={
            <>
              <Button onPress={() => setOpen(false)} isDisabled={busy}>
                Cancel
              </Button>
              <Button danger onPress={() => void confirmDelete()} isDisabled={busy}>
                Confirm delete
              </Button>
            </>
          }
        >
          <p>They stop receiving email and are removed from every media list. Only they can subscribe again.</p>
          {error && <InlineAlert variant="danger" role="alert" description={error} />}
        </AlertDialog>
      </Modal>
    </DialogTrigger>
  );
}

/**
 * `/hub/subscribers/:id` (legacy EditSubscriber): the h1 and title are always "Subscriber" —
 * never the address (Global Constraints) — while the address itself appears as the page's
 * first line under the heading. Nested under SubscribersSection, which already gates read
 * access on NoD.Viewer/Editor/Admin; write controls below are gated again here since a Viewer
 * can reach this same route.
 */
export function SubscriberScreen(): React.JSX.Element {
  const { id = "" } = useParams();
  const session = useSession();
  const timeZone = useTenantTimeZone();
  const canEdit = canEditSubscribers(session);
  useDocumentTitle("Subscriber");

  const [detail, setDetail] = useState<SubscriberDetail | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [options, setOptions] = useState<ListOptions | null>(null);

  const reload = useCallback(() => {
    apiFetch<SubscriberDetail>(`/nod/api/subscribers/${id}`).then(
      (d) => {
        setDetail(d);
        setNotFound(false);
      },
      (caught) => {
        if (caught instanceof ApiError && caught.status === 404) setNotFound(true);
      },
    );
  }, [id]);
  useEffect(() => reload(), [reload]);

  useEffect(() => {
    apiFetch<ListOptions>("/nod/api/subscriber-list-options").then(setOptions, () => {
      // The Editor form still renders with no lists offered; "All news" alone still works.
    });
  }, []);

  if (notFound) {
    return (
      <div className="gcpe-subscriber">
        <h1>Subscriber</h1>
        <p>Subscriber not found.</p>
      </div>
    );
  }

  if (!detail) {
    return (
      <div className="gcpe-subscriber">
        <h1>Subscriber</h1>
        <p>Loading…</p>
      </div>
    );
  }

  const showPreferences = detail.status === "active" || detail.status === "disabled";

  return (
    <div className="gcpe-subscriber">
      <h1>Subscriber</h1>
      <p>{detail.email}</p>

      <dl>
        <dt>Status</dt>
        <dd>{statusText(detail)}</dd>
        <dt>Source</dt>
        <dd>{SOURCE_LABELS[detail.source] ?? detail.source}</dd>
        <dt>Registered</dt>
        <dd>{formatWhen(detail.createdAt, new Date(), timeZone)}</dd>
        {detail.endedAt && (
          <>
            <dt>Ended</dt>
            <dd>{formatWhen(detail.endedAt, new Date(), timeZone)}</dd>
          </>
        )}
        {detail.mediaLists.length > 0 && (
          <>
            <dt>Media lists</dt>
            <dd>
              <ul>
                {detail.mediaLists.map((m) => (
                  <li key={m.listKey}>{m.name}</li>
                ))}
              </ul>
              <p>Managed per media list.</p>
            </dd>
          </>
        )}
      </dl>

      {detail.needsAttention && <p>{`Needs attention: ${detail.needsAttention}`}</p>}
      {detail.bouncedEmails > 0 && <p>{`Bounced emails counted (last ${detail.bounceWindowDays} days): ${detail.bouncedEmails}`}</p>}

      <p>
        <Link to={`/subscribers/${detail.id}/history`}>History</Link>
      </p>

      {showPreferences && (canEdit ? <PreferencesForm detail={detail} options={options} onSaved={reload} /> : <PreferencesView detail={detail} options={options} />)}

      {canEdit && detail.status !== "deleted" && (
        <>
          <StatusSection detail={detail} onChanged={reload} />
          <ChangeEmailSection detail={detail} onChanged={reload} />
          <DeleteSection detail={detail} onDeleted={reload} />
        </>
      )}

      {detail.status === "deleted" && (
        <p>{`Unsubscribed or deleted on ${formatWhen(detail.endedAt ?? detail.createdAt, new Date(), timeZone)}. Only they can subscribe again.`}</p>
      )}
    </div>
  );
}

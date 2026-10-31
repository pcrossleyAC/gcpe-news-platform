import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Link, useLocation, useParams } from "react-router";
import { AlertDialog, DialogTrigger, InlineAlert, Modal, Radio, RadioGroup, TextField } from "@bcgov/design-system-react-components";
import { apiFetch, ApiError } from "../../api/client";
import { formatWhen } from "../../format/dates";
import { useTenantTimeZone } from "../../format/tenantTimeZone";
import { useSession } from "../../session/SessionContext";
import { Button } from "../../shared/BusyButton";
import { Form } from "../../shared/Form";
import { useFormShortcut } from "../../shared/shortcuts";
import { useDocumentTitle } from "../../shared/useDocumentTitle";
import { canEditSubscribers } from "./access";
import { backToFrom } from "./backToResults";
import { ListPicker } from "./ListPicker";
import { attentionLabel, STATUS_LABELS, timingLabel } from "./labels";
import type { ListOptions, SubscriberDetail } from "./types";

/** apps/nod/src/db/schema.ts's subscribers_source_check. */
const SOURCE_LABELS: Record<string, string> = {
  self: "Signed up themselves",
  admin: "Added by staff",
  "media-hub": "Media Hub contact",
  "manual-media": "Added to a media list by staff",
};

/** The nightly Media Hub sync rewrites the address of a subscriber sourced from or linked to a
 * Media Hub contact, so an edit here would be undone. */
const MEDIA_HUB_MANAGED = "This address is managed in Media Hub. Change it there.";

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
  for (const [k, n] of Object.entries(detail.listNames ?? {})) names.set(k, n);
  for (const c of options?.categories ?? []) for (const l of c.lists) names.set(l.listKey, l.name);
  return (
    <div className="gcpe-subscriber__preferences">
      <h2>Preferences</h2>
      {detail.allNews && <p>All news</p>}
      <p>{timingLabel(detail)}</p>
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

/** Which success message is showing: one at a time. Every action clears the last one when it
 * starts, so a refusal, a change of address or an Activate never sits beside an earlier
 * success. */
type Notice = "preferences" | "email" | "activated" | null;
interface NoticeProps {
  notice: Notice;
  setNotice(update: (n: Notice) => Notice): void;
}
/** Clears `mine` if it's the message showing, leaving the other form's alone. */
const clearing = (mine: Exclude<Notice, null>) => (n: Notice) => (n === mine ? null : n);

/** Seeded once per subscriber (the caller keys it by id): a reload after Activate, Deactivate
 * or this form's own save keeps whatever the staff member has ticked but not yet saved. */
function PreferencesForm({ detail, options, onSaved, notice, setNotice }: { detail: SubscriberDetail; options: ListOptions | null; onSaved(): void } & NoticeProps): React.JSX.Element {
  const [allNews, setAllNews] = useState(detail.allNews);
  const [listKeys, setListKeys] = useState(detail.listKeys);
  const [asItHappens, setAsItHappens] = useState(detail.asItHappens);
  const [digest, setDigest] = useState(detail.digest);
  const [messages, setMessages] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const saved = notice === "preferences";
  const setSaved = (on: boolean) => setNotice(on ? () => "preferences" : clearing("preferences"));

  const onSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setMessages([]);
    setNotice(() => null);
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

  // ⌘/Ctrl+S saves the preferences (the screen's Save) from anywhere on it.
  const formRef = useFormShortcut("save", !saving);
  return (
    <Form ref={formRef} onSubmit={onSubmit} aria-label="Preferences" className="gcpe-subscriber__preferences">
      <h2>Preferences</h2>
      {messages.map((m) => (
        <p role="alert" key={m}>
          {m}
        </p>
      ))}
      {saved && <p role="status">Preferences saved.</p>}

      <div className="gcpe-check-row">
        <label className="gcpe-check">
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
        <label className="gcpe-check">
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
      </div>

      <ListPicker
        categories={options?.categories ?? []}
        allNews={allNews}
        listKeys={listKeys}
        heldKeys={detail.listKeys}
        heldNames={detail.listNames}
        onChange={(next) => {
          setAllNews(next.allNews);
          setListKeys(next.listKeys);
          setSaved(false);
        }}
        disabled={saving}
      />

      <Button type="submit" isPending={saving} pendingLabel="Saving…" shortcut="save">
        Save preferences
      </Button>
    </Form>
  );
}

function StatusSection({ detail, onChanged, notice, setNotice }: { detail: SubscriberDetail; onChanged(): void } & NoticeProps): React.JSX.Element {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [deactivateOpen, setDeactivateOpen] = useState(false);

  const postStatus = async (status: "active" | "disabled") => {
    setBusy(true);
    setError(null);
    setNotice(() => null);
    try {
      await apiFetch(`/nod/api/subscribers/${detail.id}/status`, { method: "POST", body: { status } });
      setDeactivateOpen(false);
      if (status === "active") setNotice(() => "activated");
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
      {notice === "activated" && <p role="status">Activated. Their bounce count starts again.</p>}
      {detail.status === "disabled" && (
        // Reversible and harmless (unlike Deactivate/Delete), so this posts at once with no
        // confirm dialog.
        <Button onPress={() => void postStatus("active")} isPending={busy}>
          Activate
        </Button>
      )}
      {detail.status === "active" && (
        <DialogTrigger isOpen={deactivateOpen} onOpenChange={setDeactivateOpen}>
          <Button variant="secondary" isPending={busy}>
            Deactivate
          </Button>
          <Modal isDismissable>
            <AlertDialog
              role="alertdialog"
              variant="warning"
              title="Deactivate this subscriber?"
              buttons={
                <>
                  <Button onPress={() => setDeactivateOpen(false)} isPending={busy}>
                    Cancel
                  </Button>
                  <Button danger onPress={() => void postStatus("disabled")} isPending={busy}>
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

/** The new address left a media list this subscriber is on: staff confirm before moving them. */
interface OptOutPrompt {
  email: string;
  at: string;
}

function ChangeEmailSection({ detail, onChanged, notice, setNotice }: { detail: SubscriberDetail; onChanged(): void } & NoticeProps): React.JSX.Element {
  const timeZone = useTenantTimeZone();
  const [email, setEmail] = useState("");
  const [confirmEmail, setConfirmEmail] = useState("");
  const [messages, setMessages] = useState<string[]>([]);
  const [takenId, setTakenId] = useState<string | null>(null);
  const [optOutPrompt, setOptOutPrompt] = useState<OptOutPrompt | null>(null);
  const [promptError, setPromptError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (detail.mediaHubLinked) {
    return <p>{MEDIA_HUB_MANAGED}</p>;
  }

  const closeOptOutPrompt = () => {
    if (busy) return;
    setOptOutPrompt(null);
    setPromptError(null);
  };

  const change = async (address: string, confirmOptOut: boolean) => {
    setBusy(true);
    setPromptError(null);
    try {
      await apiFetch(`/nod/api/subscribers/${detail.id}/email`, { method: "POST", body: confirmOptOut ? { email: address, confirmOptOut: true } : { email: address } });
      setEmail("");
      setConfirmEmail("");
      setOptOutPrompt(null);
      setNotice(() => "email");
      onChanged();
    } catch (caught) {
      const body =
        caught instanceof ApiError && caught.status === 409 && caught.body && typeof caught.body === "object"
          ? (caught.body as { error?: unknown; id?: unknown; status?: unknown; at?: unknown })
          : undefined;
      if (confirmOptOut) {
        // Shown inside the dialog the staff member is looking at.
        setPromptError(messagesOf(caught).join(" "));
      } else if (body?.error === "opted-out") {
        setOptOutPrompt({ email: address, at: typeof body.at === "string" ? body.at : "" });
      } else if (body?.error === "email-taken") {
        setMessages(["Another subscriber record already has that address."]);
        setTakenId(typeof body.id === "string" ? body.id : null);
      } else if (body?.error === "media-hub-managed") {
        setMessages([MEDIA_HUB_MANAGED]);
      } else if (body?.error === "status") {
        // SubscriberStateError, from a race (e.g. another staff member just deleted this row,
        // or it's pending) — the UI already hides this form for pending/deleted, so this is a
        // fallback, not the normal path. No address in either copy, same as every message here.
        setMessages([
          body.status === "deleted"
            ? "This subscriber has unsubscribed or been deleted, so their address can't be changed."
            : "This subscriber hasn't confirmed their email yet, so their address can't be changed.",
        ]);
      } else {
        setMessages(messagesOf(caught));
      }
    } finally {
      setBusy(false);
    }
  };

  const onSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setMessages([]);
    setTakenId(null);
    setNotice(() => null);
    const a = email.trim().toLowerCase();
    const b = confirmEmail.trim().toLowerCase();
    if (a !== b) {
      setMessages(["The two email addresses don't match."]);
      return;
    }
    void change(a, false);
  };

  return (
    <Form onSubmit={onSubmit} aria-label="Change email" className="gcpe-subscriber__change-email">
      <h2>Change email</h2>
      {messages.map((m) => (
        <p role="alert" key={m}>
          {m}
        </p>
      ))}
      {notice === "email" && <p role="status">Email address changed. No confirmation email was sent.</p>}
      {takenId && <Link to={`/subscribers/${takenId}`}>Open that record</Link>}
      <TextField
        label="New email"
        type="email"
        value={email}
        onChange={(v) => {
          setEmail(v);
          setTakenId(null);
        }}
        isReadOnly={busy}
        maxLength={MAX_EMAIL_LENGTH}
      />
      <TextField
        label="Confirm new email"
        type="email"
        value={confirmEmail}
        onChange={(v) => {
          setConfirmEmail(v);
          setTakenId(null);
        }}
        isReadOnly={busy}
        maxLength={MAX_EMAIL_LENGTH}
      />
      <Button type="submit" isPending={busy}>
        Change email
      </Button>
      <p>No confirmation email is sent. Links in emails already sent to the old address stop working, except unsubscribe links.</p>
      {optOutPrompt && (
        <Modal isOpen onOpenChange={(open) => { if (!open) closeOptOutPrompt(); }} isDismissable={!busy} isKeyboardDismissDisabled={busy}>
          <AlertDialog
            role="alertdialog"
            variant="warning"
            title="That address unsubscribed"
            buttons={
              <>
                <Button onPress={closeOptOutPrompt} isPending={busy}>
                  Cancel
                </Button>
                <Button onPress={() => void change(optOutPrompt.email, true)} isPending={busy}>
                  Change anyway
                </Button>
              </>
            }
          >
            <p>{`The new address opted out of a media list this subscriber is on${optOutPrompt.at ? ` (${formatWhen(optOutPrompt.at, new Date(), timeZone)})` : ""}. Change it only if they've asked to receive media releases there again.`}</p>
            {promptError && <InlineAlert variant="danger" role="alert" description={promptError} />}
          </AlertDialog>
        </Modal>
      )}
    </Form>
  );
}

function DeleteSection({ detail, onDeleted, setNotice }: { detail: SubscriberDetail; onDeleted(): void } & Pick<NoticeProps, "setNotice">): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // N5: why they're being deleted. "asked" keeps it as their unsubscribe (a media list re-add
  // then asks first); "other" is the plain cleanup delete. No default, so it's a real choice.
  const [why, setWhy] = useState<"asked" | "other" | null>(null);
  const [whyError, setWhyError] = useState<string | null>(null);
  const onOpenChange = (o: boolean) => {
    setOpen(o);
    setWhy(null);
    setWhyError(null);
    setError(null);
  };

  const confirmDelete = async () => {
    if (!why) return setWhyError("Choose why you’re deleting them.");
    setBusy(true);
    setError(null);
    setNotice(() => null);
    try {
      await apiFetch(`/nod/api/subscribers/${detail.id}`, { method: "DELETE", body: { askedToStop: why === "asked" } });
      setOpen(false);
      onDeleted();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <DialogTrigger isOpen={open} onOpenChange={onOpenChange}>
      <Button variant="secondary" danger isPending={busy}>
        Delete
      </Button>
      <Modal isDismissable>
        <AlertDialog
          role="alertdialog"
          variant="destructive"
          title="Delete this subscriber?"
          buttons={
            <>
              <Button onPress={() => setOpen(false)} isPending={busy}>
                Cancel
              </Button>
              <Button danger onPress={() => void confirmDelete()} isPending={busy}>
                Confirm delete
              </Button>
            </>
          }
        >
          <p>They stop receiving email and are removed from every media list. Only they can subscribe again.</p>
          <RadioGroup
            label="Why are you deleting them?"
            value={why ?? ""}
            onChange={(v) => {
              setWhy(v === "asked" ? "asked" : "other");
              setWhyError(null);
            }}
            isRequired
            isInvalid={whyError !== null}
            errorMessage={whyError ?? undefined}
          >
            <Radio value="asked">They asked us to stop sending them email</Radio>
            <Radio value="other">Something else, such as a duplicate or test record</Radio>
          </RadioGroup>
          {why === "asked" && <p>This is kept as their unsubscribe. If anyone adds them to a media list later, the Hub asks first.</p>}
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
  // Opened from Find subscribers: a way back to those same results (the search term included).
  const backTo = backToFrom(useLocation().state);

  const [detail, setDetail] = useState<SubscriberDetail | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [options, setOptions] = useState<ListOptions | null>(null);
  const [notice, setNoticeState] = useState<Notice>(null);
  const setNotice = useCallback((update: (n: Notice) => Notice) => setNoticeState(update), []);
  // Another subscriber's record never inherits this one's success message.
  useEffect(() => setNoticeState(null), [id]);

  const reload = useCallback(() => {
    apiFetch<SubscriberDetail>(`/nod/api/subscribers/${id}`).then(
      (d) => {
        setDetail(d);
        setNotFound(false);
        setLoadError(null);
      },
      (caught) => {
        if (caught instanceof ApiError && caught.status === 404) {
          setNotFound(true);
          return;
        }
        setLoadError("Couldn't load this subscriber.");
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

  if (loadError && !detail) {
    return (
      <div className="gcpe-subscriber">
        <h1>Subscriber</h1>
        <InlineAlert variant="danger" role="alert" description={loadError} />
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
      {backTo && (
        <p>
          <Link to={backTo.path} state={backTo.state}>
            Back to results
          </Link>
        </p>
      )}
      {loadError && <InlineAlert variant="danger" role="alert" description={loadError} />}
      <p>{detail.email}</p>

      <dl className="gcpe-facts">
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

      {detail.needsAttention && <p>{`Needs attention: ${attentionLabel(detail.needsAttention)}`}</p>}
      {detail.bouncedEmails > 0 && <p>{`Bounced emails counted (last ${detail.bounceWindowDays} days): ${detail.bouncedEmails}`}</p>}

      <p>
        <Link to={`/subscribers/${detail.id}/history`}>History</Link>
      </p>

      {showPreferences && (canEdit ? <PreferencesForm key={detail.id} detail={detail} options={options} onSaved={reload} notice={notice} setNotice={setNotice} /> : <PreferencesView detail={detail} options={options} />)}

      {canEdit && detail.status !== "deleted" && (
        <>
          <StatusSection detail={detail} onChanged={reload} notice={notice} setNotice={setNotice} />
          {/* Changing a pending subscriber's address would leave a row that can never be
           * confirmed (the only way in is the verify link sent to the original address) — the
           * server refuses it (SubscriberStateError), and this hides the dead end up front. */}
          {detail.status !== "pending" && <ChangeEmailSection detail={detail} onChanged={reload} notice={notice} setNotice={setNotice} />}
          <DeleteSection detail={detail} onDeleted={reload} setNotice={setNotice} />
        </>
      )}

      {detail.status === "deleted" && (
        <p>{`Unsubscribed or deleted on ${formatWhen(detail.endedAt ?? detail.createdAt, new Date(), timeZone)}. Only they can subscribe again.`}</p>
      )}
    </div>
  );
}

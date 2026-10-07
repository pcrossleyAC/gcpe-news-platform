import { useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router";
import { Button, Form, TextField } from "@bcgov/design-system-react-components";
import { apiFetch, ApiError } from "../../api/client";
import { useSession } from "../../session/SessionContext";
import { useDocumentTitle } from "../../shared/useDocumentTitle";
import { canEditSubscribers } from "./access";
import { ListPicker } from "./ListPicker";
import type { ListOptions } from "./types";

/** 400 `issues` (zod) are a different shape from a plain `message` — same split as
 * UsersScreen.messagesOf. */
function messagesOf(caught: unknown): string[] {
  if (caught instanceof ApiError) {
    if (caught.issues?.length) return caught.issues.map((i) => (i as { message?: string }).message ?? "Invalid request.");
    return [caught.message];
  }
  return ["Something went wrong."];
}

/** The existing subscriber's id from a 409 `{ error: "subscriber exists", id }` — `undefined`
 * when this wasn't that kind of 409 at all, `null` when it was but the row couldn't be found
 * (so no link is offered). */
function existingSubscriberId(caught: unknown): string | null | undefined {
  if (!(caught instanceof ApiError) || caught.status !== 409 || !caught.body || typeof caught.body !== "object") return undefined;
  const body = caught.body as { error?: unknown; id?: unknown };
  if (body.error !== "subscriber exists") return undefined;
  return typeof body.id === "string" ? body.id : null;
}

/** `/hub/subscribers/new`: the legacy AddEditSubscriber "add" path — active at once, no
 * verification email (C51). */
export function AddSubscriberScreen(): React.JSX.Element {
  const session = useSession();
  useDocumentTitle("Add a subscriber");
  const canEdit = canEditSubscribers(session);
  const navigate = useNavigate();

  const [options, setOptions] = useState<ListOptions | null>(null);
  const [email, setEmail] = useState("");
  const [confirmEmail, setConfirmEmail] = useState("");
  const [allNews, setAllNews] = useState(false);
  const [listKeys, setListKeys] = useState<string[]>([]);
  const [asItHappens, setAsItHappens] = useState(true);
  const [digest, setDigest] = useState(false);
  const [messages, setMessages] = useState<string[]>([]);
  const [existingId, setExistingId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Never fetched for anyone who can't add — the section nav already hides this screen's link;
  // this is the defense-in-depth check for a direct deep link (same pattern as UsersScreen).
  useEffect(() => {
    if (!canEdit) return;
    apiFetch<ListOptions>("/nod/api/subscriber-list-options").then(setOptions, () => {
      // The form still renders with no lists offered; "All news" alone still works.
    });
  }, [canEdit]);

  if (!canEdit) {
    return (
      <div className="gcpe-subscribers__add">
        <h1>Add a subscriber</h1>
        <p>You don&rsquo;t have permission to add subscribers.</p>
      </div>
    );
  }

  const onSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setMessages([]);
    setExistingId(null);

    const normalisedEmail = email.trim().toLowerCase();
    const normalisedConfirm = confirmEmail.trim().toLowerCase();
    if (normalisedEmail !== normalisedConfirm) {
      setMessages(["The two email addresses don't match."]);
      return;
    }
    if (!allNews && listKeys.length === 0) {
      setMessages(["Choose at least one list, or all news."]);
      return;
    }
    if (!asItHappens && !digest) {
      setMessages(["Choose As It Happens, Daily Digest, or both."]);
      return;
    }

    setSubmitting(true);
    try {
      const { id } = await apiFetch<{ id: string }>("/nod/api/subscribers", {
        method: "POST",
        body: { email: normalisedEmail, lists: allNews ? "all" : listKeys, asItHappens, digest },
      });
      navigate(`/subscribers/${id}`);
    } catch (caught) {
      const existing = existingSubscriberId(caught);
      if (existing !== undefined) {
        setMessages(["That address already has a subscriber record."]);
        setExistingId(existing);
      } else {
        setMessages(messagesOf(caught));
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="gcpe-subscribers__add">
      <h1>Add a subscriber</h1>
      <Form onSubmit={onSubmit} aria-label="Add a subscriber">
        {messages.map((m) => (
          <p role="alert" key={m}>
            {m}
          </p>
        ))}
        {existingId && <Link to={`/subscribers/${existingId}`}>Open their record</Link>}

        <TextField label="Email" type="email" value={email} onChange={setEmail} isRequired isDisabled={submitting} />
        <TextField label="Confirm email" type="email" value={confirmEmail} onChange={setConfirmEmail} isRequired isDisabled={submitting} />

        <ListPicker
          categories={options?.categories ?? []}
          allNews={allNews}
          listKeys={listKeys}
          onChange={(next) => {
            setAllNews(next.allNews);
            setListKeys(next.listKeys);
          }}
          disabled={submitting}
        />

        <label>
          <input type="checkbox" checked={asItHappens} onChange={(e) => setAsItHappens(e.target.checked)} disabled={submitting} /> As it happens
        </label>
        <label>
          <input type="checkbox" checked={digest} onChange={(e) => setDigest(e.target.checked)} disabled={submitting} /> Daily digest
        </label>

        <Button type="submit" isDisabled={submitting}>
          Add subscriber
        </Button>
      </Form>
    </div>
  );
}

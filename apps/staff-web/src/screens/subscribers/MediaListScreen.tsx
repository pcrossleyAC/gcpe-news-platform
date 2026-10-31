import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { TableScroll } from "../../shared/TableScroll";
import { Link, useParams } from "react-router";
import { AlertDialog, Form, InlineAlert, Modal, TextField } from "@bcgov/design-system-react-components";
import { apiFetch, ApiError } from "../../api/client";
import { formatWhen } from "../../format/dates";
import { useTenantTimeZone } from "../../format/tenantTimeZone";
import { useSession } from "../../session/SessionContext";
import { Button } from "../../shared/BusyButton";
import { ignoreWhileBusy } from "../../shared/guardSubmit";
import { useDocumentTitle } from "../../shared/useDocumentTitle";
import { canEditSubscribers } from "./access";
import { attentionLabel, mediaErrorText, memberSourceLabel } from "./labels";
import { MediaHubSearch } from "./MediaHubSearch";
import { ResolveDialog } from "./ResolveDialog";
import type { AddMemberBody, AddMemberResult, MediaListSummary, MediaMember, MediaOptOutPage } from "./types";

/**
 * `/hub/subscribers/media-lists/:key`: one media list's members, who left it (unsubscribed, or left it in legacy),
 * and, for Editors, add (by hand or from Media Hub), remove and resolve. The h1 and title are
 * the static "Media list"; the list name is shown below it (no async titles). Re-adding someone
 * whose records show they may have unsubscribed since they were last added may ask first, and
 * names when they left (C64).
 */
export function MediaListScreen(): React.JSX.Element {
  const { key = "" } = useParams();
  useDocumentTitle("Media list");
  const canEdit = canEditSubscribers(useSession());
  const timeZone = useTenantTimeZone();
  const base = `/nod/api/media-lists/${encodeURIComponent(key)}`;

  const [list, setList] = useState<MediaListSummary | null>(null);
  const [members, setMembers] = useState<MediaMember[] | null>(null);
  const [optOuts, setOptOuts] = useState<MediaOptOutPage | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [message, setMessage] = useState<React.ReactNode>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [optOutPrompt, setOptOutPrompt] = useState<{ body: AddMemberBody; at: string } | null>(null);
  const [removing, setRemoving] = useState<MediaMember | null>(null);
  const [resolving, setResolving] = useState<MediaMember | null>(null);

  // Only the latest load may land: after an add, remove or resolve, an earlier slower load
  // would otherwise put back the list as it was.
  const latest = useRef(0);
  const reload = useCallback(() => {
    const seq = ++latest.current;
    Promise.all([apiFetch<MediaListSummary[]>("/nod/api/media-lists"), apiFetch<MediaMember[]>(`${base}/members`), apiFetch<MediaOptOutPage>(`${base}/opted-out`)]).then(
      ([all, m, o]) => {
        if (seq !== latest.current) return;
        setList(all.find((l) => l.key === key) ?? null);
        setMembers(m);
        setOptOuts(o);
        setLoadError(null);
      },
      (e: unknown) => {
        if (seq !== latest.current) return;
        setLoadError(e instanceof ApiError && e.status === 404 ? "There's no media list with that key." : "Couldn't load this media list.");
      },
    );
  }, [base, key]);
  useEffect(() => reload(), [reload]);

  const add = async (body: AddMemberBody) => {
    setBusy(true);
    setActionError(null);
    setMessage(null);
    try {
      const added = await apiFetch<AddMemberResult>(`${base}/members`, { method: "POST", body });
      setOptOutPrompt(null);
      setEmail("");
      // A Disabled address comes onto the list for media email only (owner decision 2026-10-30).
      setMessage(
        added?.newsEmailOff ? (
          <>
            Added to the list. Their news release email stays off; <Link to={`/subscribers/${added.subscriberId}`}>open their record</Link> to turn it on.
          </>
        ) : (
          "Added to the list."
        ),
      );
      reload();
    } catch (e) {
      if (e instanceof ApiError && e.status === 409 && e.message === "opted-out") {
        setOptOutPrompt({ body, at: (e.body as { at?: string } | undefined)?.at ?? "" });
      } else {
        setActionError(mediaErrorText(e));
      }
    } finally {
      setBusy(false);
    }
  };

  const onAddManual = (e: FormEvent<HTMLFormElement>) => {
    if (ignoreWhileBusy(busy, e)) return;
    if (email.trim()) void add({ email: email.trim() });
  };

  const remove = async (m: MediaMember) => {
    setBusy(true);
    setActionError(null);
    try {
      await apiFetch(`${base}/members/${m.subscriberId}`, { method: "DELETE" });
      setRemoving(null);
      setMessage("Removed from the list.");
      reload();
    } catch {
      setActionError("Couldn't remove. Try again.");
    } finally {
      setBusy(false);
    }
  };

  const closeOptOutPrompt = () => {
    setOptOutPrompt(null);
    setActionError(null);
  };
  const closeRemoving = () => {
    setRemoving(null);
    setActionError(null);
  };

  return (
    <div className="gcpe-subscribers__media-list">
      <h1>Media list</h1>
      <p>
        <Link to="/subscribers/media-lists">All media lists</Link>
      </p>
      {list && (
        <p>
          <strong>{list.name}</strong>
          {!list.active && " (retired: releases can no longer be sent to it)"}
        </p>
      )}
      {loadError && <InlineAlert variant="danger" role="alert" description={loadError} />}
      {message && <p role="status">{message}</p>}
      {/* While a confirm dialog is open, its own failure is shown inside it: the modal hides the page. */}
      {actionError && !optOutPrompt && !removing && <InlineAlert variant="danger" role="alert" description={actionError} />}

      {!members && !loadError && <p>Loading…</p>}
      {members && members.length === 0 && <p>No members yet.</p>}
      {members && members.length > 0 && (
        <TableScroll label="Members">
          <table className="gcpe-table" aria-label="Members">
            <thead>
              <tr>
                <th scope="col">Email</th>
                <th scope="col">Source</th>
                <th scope="col">Needs attention</th>
                {canEdit && <th scope="col">Actions</th>}
              </tr>
            </thead>
            <tbody>
              {members.map((m) => (
                <tr key={m.subscriberId}>
                  <td>
                    <Link to={`/subscribers/${m.subscriberId}`}>{m.email}</Link>
                  </td>
                  <td>{memberSourceLabel(m.source)}</td>
                  <td>{m.needsAttention ? attentionLabel(m.needsAttention) : ""}</td>
                  {canEdit && (
                    <td>
                      {m.needsAttention && (
                        <Button variant="secondary" isPending={busy} onPress={() => setResolving(m)}>
                          {`Resolve ${m.email}`}
                        </Button>
                      )}
                      <Button
                        variant="secondary"
                        danger
                        isPending={busy}
                        onPress={() => {
                          setActionError(null);
                          setRemoving(m);
                        }}
                      >
                        {`Remove ${m.email}`}
                      </Button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </TableScroll>
      )}

      {canEdit && members && (
        <>
          <section aria-labelledby="add-manual-heading">
            <h2 id="add-manual-heading">Add an address by hand</h2>
            <p>For people who aren&rsquo;t in Media Hub.</p>
            <Form onSubmit={onAddManual} aria-label="Add an address by hand">
              <TextField label="Email address" name="email" value={email} onChange={setEmail} />
              <Button type="submit" isPending={busy}>
                Add to list
              </Button>
            </Form>
          </section>
          <MediaHubSearch onAdd={(body) => void add(body)} busy={busy} />
        </>
      )}

      <section aria-labelledby="opted-out-heading">
        <h2 id="opted-out-heading">Left this list</h2>
        <p>They unsubscribed, or left it in the old system.</p>
        {optOuts && optOuts.items.length === 0 && <p>Nobody has.</p>}
        {optOuts && optOuts.items.length > 0 && (
          <TableScroll label="Left this list">
            <table className="gcpe-table" aria-label="Left this list">
              <thead>
                <tr>
                  <th scope="col">Email</th>
                  <th scope="col">Left</th>
                  <th scope="col">Back on the list</th>
                </tr>
              </thead>
              <tbody>
                {optOuts.items.map((o) => (
                  <tr key={o.subscriberId}>
                    <td>
                      <Link to={`/subscribers/${o.subscriberId}`}>{o.email}</Link>
                    </td>
                    <td>{formatWhen(o.at, new Date(), timeZone)}</td>
                    <td>{o.member ? "Yes" : "No"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableScroll>
        )}
        {optOuts?.truncated && <p>Showing the most recent 200.</p>}
      </section>

      {optOutPrompt && (
        <Modal isOpen onOpenChange={(open) => { if (!open) closeOptOutPrompt(); }} isDismissable>
          <AlertDialog
            role="alertdialog"
            variant="warning"
            title="This person unsubscribed"
            buttons={
              <>
                <Button onPress={closeOptOutPrompt} isPending={busy}>
                  Cancel
                </Button>
                <Button onPress={() => void add({ ...optOutPrompt.body, confirmOptOut: true })} isPending={busy}>
                  Add anyway
                </Button>
              </>
            }
          >
            <p>{`Our records show they left ${optOutPrompt.at ? formatWhen(optOutPrompt.at, new Date(), timeZone) : "earlier"}: they unsubscribed, or left it in the old system. Add them only if they've asked to receive media releases again.`}</p>
            {actionError && <InlineAlert variant="danger" role="alert" description={actionError} />}
          </AlertDialog>
        </Modal>
      )}

      {removing && (
        <Modal isOpen onOpenChange={(open) => { if (!open) closeRemoving(); }} isDismissable>
          <AlertDialog
            role="alertdialog"
            variant="destructive"
            title={`Remove ${removing.email} from this list?`}
            buttons={
              <>
                <Button onPress={closeRemoving} isPending={busy}>
                  Cancel
                </Button>
                <Button danger onPress={() => void remove(removing)} isPending={busy}>
                  Confirm remove
                </Button>
              </>
            }
          >
            <p>If this is their last list and they were added only for media lists, they stop receiving email altogether.</p>
            {actionError && <InlineAlert variant="danger" role="alert" description={actionError} />}
          </AlertDialog>
        </Modal>
      )}

      {resolving && (
        <ResolveDialog
          member={resolving}
          onClose={() => setResolving(null)}
          onResolved={(text) => {
            setResolving(null);
            setMessage(text);
            reload();
          }}
        />
      )}
    </div>
  );
}

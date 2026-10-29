import { useCallback, useEffect, useId, useRef, useState } from "react";
import { TableScroll } from "../../../shared/TableScroll";
import { Button } from "../../../shared/BusyButton";
import { useFormShortcut } from "../../../shared/shortcuts";
import { InlineAlert } from "@bcgov/design-system-react-components";
import { formatLongDate, type GovernmentTermList, type GovernmentTermPatch, type GovernmentTermView } from "@gcpe/nrms-contract";
import { apiFetch } from "../../../api/client";
import { useSession } from "../../../session/SessionContext";
import { useDocumentTitle } from "../../../shared/useDocumentTitle";
import { messagesOf } from "../messages";
import { isCoreAdmin } from "../organizations/access";
import { StartTermForm } from "./StartTermForm";

const STATUS_WORDS: Record<GovernmentTermView["status"], string> = {
  current: "Current",
  past: "Past",
  scheduled: "Scheduled",
  undated: "Undated",
};

const nameOf = (t: GovernmentTermView): string => t.label ?? t.slug;

/** The dates column, generated from the term's own dates: nobody types a range. */
function rangeOf(t: GovernmentTermView): string {
  if (t.startDate === null) return "Needs a start date";
  const start = formatLongDate(t.startDate);
  if (t.status === "scheduled") return `Scheduled: starts ${start}`;
  return `${start} to ${t.endDate ? formatLongDate(t.endDate) : "current date"}`;
}

/**
 * `/hub/government-terms` (Core.Admin): the government terms the public archive is grouped by.
 * A term's date range is worked out from the start dates, so staff only ever choose a start
 * date. "Start new government term" schedules the next one (or starts it today); a term that
 * hasn't started yet can be deleted; any term's name, start date and old-archive address can
 * be edited.
 */
export function GovernmentTermsScreen(): React.JSX.Element {
  const session = useSession();
  useDocumentTitle("Government terms");
  const admin = isCoreAdmin(session);
  const [terms, setTerms] = useState<GovernmentTermView[] | null>(null);
  const [today, setToday] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [messages, setMessages] = useState<string[]>([]);
  const [status, setStatus] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const startButton = useRef<HTMLButtonElement>(null);
  const editButtons = useRef(new Map<string, HTMLButtonElement>());
  const deleteButtons = useRef(new Map<string, HTMLButtonElement>());
  const confirmGroups = useRef(new Map<string, HTMLDivElement>());
  // Where focus goes once the next render has the element: an edit button, a delete button, a confirm group, or the Start button.
  const focusNext = useRef<{ kind: "edit" | "delete" | "confirm"; id: string } | "start" | null>(null);
  const latest = useRef(0);

  const reload = useCallback(() => {
    const call = ++latest.current;
    setLoading(true);
    apiFetch<GovernmentTermList>("/nrms/api/government-terms")
      .then(
        (l) => {
          if (call === latest.current) {
            setTerms(l.terms);
            setToday(l.today);
            setLoadError(null);
          }
        },
        () => {
          if (call === latest.current) setLoadError("Couldn't load government terms. Try again, or ask a Hub administrator if this keeps happening.");
        },
      )
      .finally(() => {
        if (call === latest.current) setLoading(false);
      });
  }, []);

  useEffect(() => {
    if (admin) reload();
  }, [admin, reload]);

  useEffect(() => {
    const f = focusNext.current;
    if (!f) return;
    const el =
      f === "start"
        ? startButton.current
        : f.kind === "edit"
          ? editButtons.current.get(f.id)
          : f.kind === "delete"
            ? deleteButtons.current.get(f.id)
            : confirmGroups.current.get(f.id);
    if (el) {
      el.focus();
      focusNext.current = null;
    }
  }, [terms, starting, editingId, deletingId, deleteError]);

  if (!admin) {
    return (
      <div className="gcpe-government-terms">
        <h1>Government terms</h1>
        <p>You don&rsquo;t have permission to view this page.</p>
      </div>
    );
  }

  const remove = async (t: GovernmentTermView) => {
    if (busy) return;
    setBusy(true);
    setMessages([]);
    setDeleteError([]);
    setStatus(null);
    try {
      await apiFetch(`/nrms/api/government-terms/${encodeURIComponent(t.id)}`, { method: "DELETE" });
      focusNext.current = "start";
      setDeletingId(null);
      setStatus(`The term starting ${t.startDate ? formatLongDate(t.startDate) : "on no date"} is deleted.`);
      reload();
    } catch (caught) {
      focusNext.current = { kind: "confirm", id: t.id };
      setDeleteError(messagesOf(caught));
    } finally {
      setBusy(false);
    }
  };

  const editing = terms?.find((t) => t.id === editingId);

  return (
    <div className="gcpe-government-terms">
      <h1>Government terms</h1>
      <p>
        The public archive groups releases by government term. Each term&rsquo;s dates are worked out from its start date:
        a term runs until the day before the next one starts.
      </p>
      {loadError && (
        <>
          <InlineAlert variant="danger" role="alert" description={loadError} />
          <p>
            <button type="button" className="gcpe-native-button" onClick={reload} disabled={loading} aria-busy={loading}>
              {loading ? "Trying again…" : "Try again"}
            </button>
          </p>
        </>
      )}
      {messages.map((m) => (
        <p role="alert" key={m}>
          {m}
        </p>
      ))}
      {status && <p role="status">{status}</p>}
      {terms === null && !loadError && <p>Loading…</p>}
      {terms && !starting && (
        <p>
          <Button
            variant="secondary"
            ref={startButton}
            onPress={() => {
              setStatus(null);
              setMessages([]);
              setEditingId(null);
              setDeletingId(null);
              setStarting(true);
            }}
          >
            Start new government term
          </Button>
        </p>
      )}
      {terms && starting && (
        <StartTermForm
          scheduledStart={terms.find((t) => t.status === "scheduled")?.startDate ?? null}
          onCancel={() => {
            focusNext.current = "start";
            setStarting(false);
          }}
          onStarted={(created) => {
            focusNext.current = "start";
            setStarting(false);
            setMessages([]);
            setStatus(
              created.startDate && (today === null || created.startDate > today)
                ? `Saved. The archive switches to the new term on ${formatLongDate(created.startDate)}.`
                : "Saved. The new term is now the current term.",
            );
            reload();
          }}
        />
      )}
      {editing && (
        <TermEditForm
          key={editing.id}
          term={editing}
          hasEarlier={editing.startDate !== null && (terms ?? []).some((t) => t.startDate !== null && t.startDate < editing.startDate!)}
          onCancel={() => {
            focusNext.current = { kind: "edit", id: editing.id };
            setEditingId(null);
          }}
          onSaved={() => {
            focusNext.current = { kind: "edit", id: editing.id };
            setEditingId(null);
            setMessages([]);
            setStatus("Saved.");
            reload();
          }}
        />
      )}
      {terms && (
        <TableScroll label="Government terms">
          <table className="gcpe-table">
            <caption>Government terms, newest first</caption>
            <thead>
              <tr>
                <th scope="col">Term</th>
                <th scope="col">Dates</th>
                <th scope="col">Status</th>
                <th scope="col">Releases</th>
                <th scope="col">Actions</th>
              </tr>
            </thead>
            <tbody>
              {terms.map((t) => (
                <tr key={t.id}>
                  <td>{nameOf(t)}</td>
                  <td>{rangeOf(t)}</td>
                  <td>{STATUS_WORDS[t.status]}</td>
                  <td>{t.releaseCount}</td>
                  <td>
                    <div className="gcpe-button-row">
                      <Button
                        size="small"
                        variant="secondary"
                        ref={(el) => {
                          if (el) editButtons.current.set(t.id, el);
                          else editButtons.current.delete(t.id);
                        }}
                        aria-label={`Edit ${nameOf(t)}`}
                        onPress={() => {
                          setStatus(null);
                          setMessages([]);
                          setStarting(false);
                          setDeletingId(null);
                          setEditingId(t.id);
                        }}
                      >
                        Edit
                      </Button>
                      {t.status === "scheduled" && t.releaseCount === 0 && deletingId !== t.id && (
                        <Button
                          size="small"
                          variant="secondary"
                          danger
                          ref={(el) => {
                            if (el) deleteButtons.current.set(t.id, el);
                            else deleteButtons.current.delete(t.id);
                          }}
                          aria-label={`Delete ${nameOf(t)}`}
                          isPending={busy}
                          onPress={() => {
                            setStatus(null);
                            setMessages([]);
                            setDeleteError([]);
                            focusNext.current = { kind: "confirm", id: t.id };
                            setDeletingId(t.id);
                          }}
                        >
                          Delete
                        </Button>
                      )}
                    </div>
                    {deletingId === t.id && (
                      <div
                        role="group"
                        tabIndex={-1}
                        ref={(el) => {
                          if (el) confirmGroups.current.set(t.id, el);
                          else confirmGroups.current.delete(t.id);
                        }}
                        aria-label={`Delete ${nameOf(t)}`}
                        aria-describedby={`delete-${t.id}`}
                      >
                        <p id={`delete-${t.id}`}>
                          Delete the term starting {t.startDate ? formatLongDate(t.startDate) : "on no date"}? Nothing is
                          listed under it yet, and the current term stays as it is.
                        </p>
                        {deleteError.map((m) => (
                          <p role="alert" key={m}>
                            {m}
                          </p>
                        ))}
                        <div className="gcpe-button-row">
                          <Button size="small" danger isPending={busy} onPress={() => void remove(t)}>
                            Confirm
                          </Button>
                          <Button
                            size="small"
                            variant="secondary"
                            onPress={() => {
                              focusNext.current = { kind: "delete", id: t.id };
                              setDeleteError([]);
                              setDeletingId(null);
                            }}
                          >
                            Cancel
                          </Button>
                        </div>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableScroll>
      )}
    </div>
  );
}

/** Edits a term's name, start date and old-archive address; sends only what changed. */
function TermEditForm({
  term,
  hasEarlier,
  onSaved,
  onCancel,
}: {
  term: GovernmentTermView;
  /** Another dated term starts before this one (so moving this start also moves that term's end). */
  hasEarlier: boolean;
  onSaved: () => void;
  onCancel: () => void;
}): React.JSX.Element {
  const uid = useId();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const [label, setLabel] = useState(term.label ?? "");
  const [startDate, setStartDate] = useState(term.startDate ?? "");
  const [url, setUrl] = useState(term.legacyArchiveUrl ?? "");
  const confirmRef = useRef<HTMLDivElement>(null);
  const saveRef = useRef<HTMLButtonElement>(null);
  const [confirmingMove, setConfirmingMove] = useState(false);
  const [busy, setBusy] = useState(false);
  const [messages, setMessages] = useState<string[]>([]);
  const started = term.status === "current" || term.status === "past";

  useEffect(() => {
    headingRef.current?.focus();
  }, []);
  useEffect(() => {
    if (confirmingMove) confirmRef.current?.focus();
  }, [confirmingMove]);

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    const body: GovernmentTermPatch = {};
    const newLabel = label.trim() === "" ? null : label.trim();
    if (newLabel !== term.label) body.label = newLabel;
    if (startDate !== "" && startDate !== term.startDate) body.startDate = startDate;
    const newUrl = url.trim() === "" ? null : url.trim();
    if (newUrl !== term.legacyArchiveUrl) body.legacyArchiveUrl = newUrl;
    if (Object.keys(body).length === 0) {
      setMessages(["No changes to save."]);
      return;
    }
    // Moving a started term's date moves releases between terms, so ask first.
    if (started && body.startDate !== undefined && !confirmingMove) {
      setMessages([]);
      setConfirmingMove(true);
      return;
    }
    setBusy(true);
    setMessages([]);
    try {
      await apiFetch(`/nrms/api/government-terms/${encodeURIComponent(term.id)}`, { method: "PATCH", body });
      onSaved();
    } catch (caught) {
      setMessages(messagesOf(caught));
    } finally {
      setBusy(false);
    }
  };

  // ⌘/Ctrl+S saves the term being edited, as its Save does.
  const formRef = useFormShortcut("save", true, true);
  return (
    <form ref={formRef} onSubmit={save} aria-label={`Edit ${nameOf(term)}`} className="gcpe-stack" noValidate>
      <h2 ref={headingRef} tabIndex={-1}>
        Edit {nameOf(term)}
      </h2>
      {!confirmingMove &&
        messages.map((m) => (
          <p role="alert" key={m}>
            {m}
          </p>
        ))}
      <div>
        <label htmlFor={`${uid}-label`}>Name</label>
        <input id={`${uid}-label`} type="text" maxLength={255} disabled={confirmingMove} value={label} onChange={(e) => setLabel(e.target.value)} />
      </div>
      <div>
        <label htmlFor={`${uid}-date`}>Start date</label>
        <input id={`${uid}-date`} type="date" disabled={confirmingMove} value={startDate} onChange={(e) => setStartDate(e.target.value)} />
      </div>
      <div>
        <label htmlFor={`${uid}-url`}>Old archive web address</label>
        <input
          id={`${uid}-url`}
          type="url"
          disabled={confirmingMove}
          value={url}
          aria-describedby={`${uid}-url-hint`}
          onChange={(e) => setUrl(e.target.value)}
        />
        <p id={`${uid}-url-hint`}>Optional. Must start with https://. Leave empty for none.</p>
      </div>
      <div className="gcpe-button-row">
        <Button type="submit" ref={saveRef} isPending={busy} isDisabled={confirmingMove} shortcut="save">
          Save
        </Button>
        <Button variant="secondary" onPress={onCancel}>
          Cancel
        </Button>
      </div>
      {confirmingMove && (
        <div role="group" tabIndex={-1} ref={confirmRef} aria-label="Confirm the new start date" aria-describedby={`${uid}-move`}>
          <p id={`${uid}-move`}>
            {`Change the start date to ${formatLongDate(startDate)}? Releases published from that day will be listed under this term${hasEarlier ? ", and the term before it will end the day before" : ""}.`}
          </p>
          {messages.map((m) => (
            <p role="alert" key={m}>
              {m}
            </p>
          ))}
          <div className="gcpe-button-row">
            <Button type="submit" isPending={busy}>
              Confirm
            </Button>
            <Button
              variant="secondary"
              isPending={busy}
              onPress={() => {
                setConfirmingMove(false);
                setMessages([]);
                setTimeout(() => saveRef.current?.focus(), 0);
              }}
            >
              Go back
            </Button>
          </div>
        </div>
      )}
    </form>
  );
}

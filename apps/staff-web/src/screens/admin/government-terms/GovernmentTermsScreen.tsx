import { useCallback, useEffect, useId, useRef, useState } from "react";
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
  const [loadError, setLoadError] = useState<string | null>(null);
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
    apiFetch<GovernmentTermList>("/nrms/api/government-terms").then(
      (l) => {
        if (call === latest.current) {
          setTerms(l.terms);
          setLoadError(null);
        }
      },
      () => {
        if (call === latest.current) setLoadError("Couldn't load government terms.");
      },
    );
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
  }, [terms, starting, editingId, deletingId]);

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
    setStatus(null);
    try {
      await apiFetch(`/nrms/api/government-terms/${encodeURIComponent(t.id)}`, { method: "DELETE" });
      focusNext.current = "start";
      setDeletingId(null);
      setStatus(`The term starting ${t.startDate ? formatLongDate(t.startDate) : "on no date"} is deleted.`);
      reload();
    } catch (caught) {
      setMessages(messagesOf(caught));
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
      {loadError && <InlineAlert variant="danger" role="alert" description={loadError} />}
      {messages.map((m) => (
        <p role="alert" key={m}>
          {m}
        </p>
      ))}
      {status && <p role="status">{status}</p>}
      {terms === null && !loadError && <p>Loading…</p>}
      {terms && !starting && (
        <p>
          <button
            type="button"
            ref={startButton}
            onClick={() => {
              setStatus(null);
              setMessages([]);
              setEditingId(null);
              setDeletingId(null);
              setStarting(true);
            }}
          >
            Start new government term
          </button>
        </p>
      )}
      {terms && starting && (
        <StartTermForm
          onCancel={() => {
            focusNext.current = "start";
            setStarting(false);
          }}
          onStarted={(created) => {
            focusNext.current = "start";
            setStarting(false);
            setMessages([]);
            const when = created.startDate ? formatLongDate(created.startDate) : "the chosen date";
            setStatus(`Saved. The archive switches to the new term on ${when}.`);
            reload();
          }}
        />
      )}
      {editing && (
        <TermEditForm
          key={editing.id}
          term={editing}
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
                  <button
                    type="button"
                    ref={(el) => {
                      if (el) editButtons.current.set(t.id, el);
                      else editButtons.current.delete(t.id);
                    }}
                    aria-label={`Edit ${nameOf(t)}`}
                    onClick={() => {
                      setStatus(null);
                      setMessages([]);
                      setStarting(false);
                      setDeletingId(null);
                      setEditingId(t.id);
                    }}
                  >
                    Edit
                  </button>
                  {t.status === "scheduled" && deletingId !== t.id && (
                    <>
                      {" "}
                      <button
                        type="button"
                        ref={(el) => {
                          if (el) deleteButtons.current.set(t.id, el);
                          else deleteButtons.current.delete(t.id);
                        }}
                        aria-label={`Delete ${nameOf(t)}`}
                        disabled={busy}
                        onClick={() => {
                          setStatus(null);
                          setMessages([]);
                          focusNext.current = { kind: "confirm", id: t.id };
                          setDeletingId(t.id);
                        }}
                      >
                        Delete
                      </button>
                    </>
                  )}
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
                      <button type="button" disabled={busy} onClick={() => void remove(t)}>
                        Confirm
                      </button>{" "}
                      <button
                        type="button"
                        onClick={() => {
                          focusNext.current = { kind: "delete", id: t.id };
                          setDeletingId(null);
                        }}
                      >
                        Cancel
                      </button>
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

/** Edits a term's name, start date and old-archive address; sends only what changed. */
function TermEditForm({
  term,
  onSaved,
  onCancel,
}: {
  term: GovernmentTermView;
  onSaved: () => void;
  onCancel: () => void;
}): React.JSX.Element {
  const uid = useId();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const [label, setLabel] = useState(term.label ?? "");
  const [startDate, setStartDate] = useState(term.startDate ?? "");
  const [url, setUrl] = useState(term.legacyArchiveUrl ?? "");
  const [busy, setBusy] = useState(false);
  const [messages, setMessages] = useState<string[]>([]);

  useEffect(() => {
    headingRef.current?.focus();
  }, []);

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

  return (
    <form onSubmit={save} aria-label={`Edit ${nameOf(term)}`} className="gcpe-stack" noValidate>
      <h2 ref={headingRef} tabIndex={-1}>
        Edit {nameOf(term)}
      </h2>
      {messages.map((m) => (
        <p role="alert" key={m}>
          {m}
        </p>
      ))}
      <div>
        <label htmlFor={`${uid}-label`}>Name</label>
        <input id={`${uid}-label`} type="text" value={label} onChange={(e) => setLabel(e.target.value)} />
      </div>
      <div>
        <label htmlFor={`${uid}-date`}>Start date</label>
        <input id={`${uid}-date`} type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
      </div>
      <div>
        <label htmlFor={`${uid}-url`}>Old archive web address</label>
        <input
          id={`${uid}-url`}
          type="url"
          value={url}
          aria-describedby={`${uid}-url-hint`}
          onChange={(e) => setUrl(e.target.value)}
        />
        <p id={`${uid}-url-hint`}>Optional. Must start with https://. Leave empty for none.</p>
      </div>
      <div>
        <button type="submit" disabled={busy}>
          Save
        </button>{" "}
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}

import { useEffect, useId, useRef, useState } from "react";
import { formatLongDate, type GovernmentTermView } from "@gcpe/nrms-contract";
import { apiFetch } from "../../../api/client";
import { messagesOf } from "../messages";

/** The day before an ISO date (`YYYY-MM-DD`), computed on the calendar so no time zone can shift it. */
export function dayBefore(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y!, m! - 1, d! - 1)).toISOString().slice(0, 10);
}

export interface StartTermFormProps {
  /** Start date of a term already scheduled (not begun), if any; the new term follows it. */
  scheduledStart?: string | null;
  onStarted: (term: GovernmentTermView) => void;
  onCancel: () => void;
}

/**
 * Starts a new government term (`POST /nrms/api/government-terms`, Core.Admin). Two steps in
 * the page: pick the date (and an optional name), then read what will happen and confirm. The
 * server's refusals (a date that isn't after the latest term, a date already taken) are shown
 * on the confirm step in its own words.
 */
export function StartTermForm({ scheduledStart = null, onStarted, onCancel }: StartTermFormProps): React.JSX.Element {
  const uid = useId();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const confirmRef = useRef<HTMLDivElement>(null);
  const continueRef = useRef<HTMLButtonElement>(null);
  const [startDate, setStartDate] = useState("");
  const [label, setLabel] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [messages, setMessages] = useState<string[]>([]);

  useEffect(() => {
    headingRef.current?.focus();
  }, []);
  useEffect(() => {
    if (confirming) confirmRef.current?.focus();
  }, [confirming]);

  const dateOk = /^\d{4}-\d{2}-\d{2}$/.test(startDate);

  const confirm = async () => {
    if (busy || !dateOk) return;
    setBusy(true);
    setMessages([]);
    try {
      const created = await apiFetch<GovernmentTermView>("/nrms/api/government-terms", {
        method: "POST",
        body: { startDate, label: label.trim() === "" ? null : label.trim() },
      });
      onStarted(created);
    } catch (caught) {
      setMessages(messagesOf(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      aria-label="Start a new government term"
      className="gcpe-stack"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        if (!dateOk || confirming) return;
        setMessages([]);
        setConfirming(true);
      }}
    >
      <h2 ref={headingRef} tabIndex={-1}>
        Start a new government term
      </h2>
      <div>
        <label htmlFor={`${uid}-date`}>Start date (required)</label>
        <input
          id={`${uid}-date`}
          type="date"
          value={startDate}
          disabled={confirming}
          aria-describedby={`${uid}-date-hint`}
          onChange={(e) => setStartDate(e.target.value)}
        />
        <p id={`${uid}-date-hint`}>The first day of the new government, for example the swearing-in date.</p>
      </div>
      <div>
        <label htmlFor={`${uid}-label`}>Name (optional)</label>
        <input id={`${uid}-label`} type="text" maxLength={255} value={label} disabled={confirming} onChange={(e) => setLabel(e.target.value)} />
      </div>
      {!confirming && (
        <div>
          <button type="submit" ref={continueRef} disabled={!dateOk}>
            Continue
          </button>{" "}
          <button type="button" onClick={onCancel}>
            Cancel
          </button>
        </div>
      )}
      {confirming && (
        <div role="group" tabIndex={-1} ref={confirmRef} aria-label="Confirm the new term" aria-describedby={`${uid}-confirm`}>
          <p id={`${uid}-confirm`}>
            {scheduledStart
              ? `Start a new government term on ${formatLongDate(startDate)}? The term already scheduled to start ${formatLongDate(scheduledStart)} will end ${formatLongDate(dayBefore(startDate))}. Releases published from that day are listed under the new term.`
              : `Start a new government term on ${formatLongDate(startDate)}? The current term will end ${formatLongDate(dayBefore(startDate))}. Releases published from that day are listed under the new term.`}
          </p>
          {messages.map((m) => (
            <p role="alert" key={m}>
              {m}
            </p>
          ))}
          <button type="button" disabled={busy} onClick={() => void confirm()}>
            Confirm
          </button>{" "}
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              setConfirming(false);
              setMessages([]);
              setTimeout(() => continueRef.current?.focus(), 0);
            }}
          >
            Go back
          </button>
        </div>
      )}
    </form>
  );
}

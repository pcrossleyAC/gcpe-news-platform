import { useEffect, useRef, useState } from "react";
import { Button, InlineAlert } from "@bcgov/design-system-react-components";
import { ApiError, apiFetch } from "../../../api/client";
import { useDocumentTitle } from "../../../shared/useDocumentTitle";
import { messagesOf } from "../../admin/messages";
import { plural, type TransferContact, type TransferPreview } from "./types";

interface TransferResult {
  transferred: number;
  /** A later batch failed after earlier ones committed (apps/calendar/src/transfer.ts's
   * TransferResult); the response is still a 2xx (207), so this reads as a result, not a thrown
   * ApiError. */
  failed?: true;
}

/** A 404 means a chosen contact is gone, or no longer one the caller may use, since the page loaded. */
const errorsOf = (caught: unknown) =>
  caught instanceof ApiError && caught.status === 404 ? ["That comm contact is no longer available: reload the page."] : messagesOf(caught);

/** `/hub/calendar/transfer` (spec addendum §8.5): move every activity of one comm contact to another. */
export function TransferScreen(): React.JSX.Element {
  useDocumentTitle("Transfer activities");
  const [contacts, setContacts] = useState<TransferContact[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [preview, setPreview] = useState<TransferPreview | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const latest = useRef(0);

  useEffect(() => {
    const call = ++latest.current;
    apiFetch<TransferContact[]>("/calendar/api/transfer/comm-contacts").then(
      (c) => call === latest.current && setContacts(c),
      () => call === latest.current && setLoadError("Couldn't load comm contacts."),
    );
  }, []);

  const choose = (setter: (v: string) => void) => (e: React.ChangeEvent<HTMLSelectElement>) => {
    setter(e.target.value);
    setPreview(null);
    setStatus(null);
    setErrors([]);
  };
  const doPreview = async () => {
    setBusy(true);
    setErrors([]);
    setStatus(null);
    try {
      setPreview(await apiFetch<TransferPreview>(`/calendar/api/transfer/preview?from=${from}&to=${to}`));
    } catch (caught) {
      setErrors(errorsOf(caught));
    } finally {
      setBusy(false);
    }
  };
  const doTransfer = async () => {
    if (!preview) return;
    setBusy(true);
    setErrors([]);
    setStatus(null);
    try {
      const out = await apiFetch<TransferResult>("/calendar/api/transfer", { method: "POST", body: { from: preview.from.id, to: preview.to.id } });
      if (out.failed) {
        setErrors([`Only ${plural(out.transferred)} moved from ${preview.from.label} to ${preview.to.label} before a later batch failed. Preview again and try the rest.`]);
      } else {
        setStatus(`Transferred ${plural(out.transferred)} from ${preview.from.label} to ${preview.to.label}.`);
      }
      setPreview(null);
    } catch (caught) {
      setErrors(errorsOf(caught));
    } finally {
      setBusy(false);
    }
  };

  if (loadError) return <InlineAlert variant="danger" role="alert" description={loadError} />;
  return (
    <div>
      <h1>Transfer activities</h1>
      <p>Moves every activity of one comm contact, past ones included, to another, and makes the second contact&rsquo;s ministry the lead ministry. Deleted activities stay where they are.</p>
      {status && <p role="status">{status}</p>}
      {contacts === null ? (
        <p>Loading…</p>
      ) : (
        <form
          className="gcpe-stack"
          aria-label="Transfer activities"
          onSubmit={(e) => {
            e.preventDefault();
            void doPreview();
          }}
        >
          <div className="gcpe-field">
            <label htmlFor="transfer-from">From comm contact</label>
            <select id="transfer-from" value={from} onChange={choose(setFrom)}>
              <option value="">Choose a comm contact</option>
              {contacts.map((c) => (
                <option key={c.id} value={String(c.id)}>
                  {c.isActive && c.userIsActive ? c.label : `${c.label} — inactive`}
                </option>
              ))}
            </select>
          </div>
          <div className="gcpe-field">
            <label htmlFor="transfer-to">To comm contact</label>
            <select id="transfer-to" value={to} onChange={choose(setTo)}>
              <option value="">Choose a comm contact</option>
              {contacts
                .filter((c) => c.canReceive)
                .map((c) => (
                  <option key={c.id} value={String(c.id)}>
                    {c.label}
                  </option>
                ))}
            </select>
          </div>
          {errors.map((m) => (
            <p role="alert" key={m}>
              {m}
            </p>
          ))}
          <Button type="submit" isDisabled={busy || !from || !to}>
            Preview
          </Button>
        </form>
      )}
      {preview && (
        <section aria-label="Transfer preview">
          <p>{`${plural(preview.count)} will move from ${preview.from.label} to ${preview.to.label}. Their lead ministry becomes ${preview.to.ministryName}.`}</p>
          <Button onPress={() => void doTransfer()} isDisabled={busy || preview.count === 0}>{`Transfer ${plural(preview.count)}`}</Button>
        </section>
      )}
    </div>
  );
}

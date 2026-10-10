import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { AlertDialog, Button, Form, InlineAlert, Modal, TextField } from "@bcgov/design-system-react-components";
import { apiFetch, ApiError } from "../../../api/client";
import { useSession } from "../../../session/SessionContext";
import { useDocumentTitle } from "../../../shared/useDocumentTitle";

interface MediaListRecord {
  key: string;
  displayName: string;
  sortOrder: number;
  isActive: boolean;
}

/** `/hub/media-list-names`: NRMS owns media-list keys and names (C47); NoD mirrors them through
 * events within a minute. Core.Admin only, the role NRMS's media-list admin routes require. */
export function MediaListNamesScreen(): React.JSX.Element {
  useDocumentTitle("Media list names");
  if (!useSession().has("Core.Admin")) {
    return (
      <div className="gcpe-admin__media-lists">
        <h1>Media list names</h1>
        <p>You don&rsquo;t have permission to manage media list names.</p>
      </div>
    );
  }
  return <MediaListNamesEditor />;
}

function MediaListNamesEditor(): React.JSX.Element {
  const [rows, setRows] = useState<MediaListRecord[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [key, setKey] = useState("");
  const [name, setName] = useState("");
  const [addError, setAddError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Only the latest load may land: an earlier, slower load landing after a faster later one
  // would put back stale rows.
  const latest = useRef(0);
  const reload = useCallback(() => {
    const seq = ++latest.current;
    apiFetch<MediaListRecord[]>("/nrms/api/media-lists").then(
      (r) => {
        if (seq !== latest.current) return;
        setRows(r);
        setLoadError(null);
      },
      () => {
        if (seq !== latest.current) return;
        setLoadError("Couldn't load media lists.");
      },
    );
  }, []);
  useEffect(() => reload(), [reload]);

  const onAdd = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setBusy(true);
    setAddError(null);
    try {
      await apiFetch("/nrms/api/media-lists", { method: "POST", body: { key: key.trim(), displayName: name.trim() } });
      setKey("");
      setName("");
      setMessage("Media list added. It reaches News On Demand within a minute.");
      reload();
    } catch (err) {
      setAddError(
        err instanceof ApiError && err.status === 409
          ? "A media list with that key already exists."
          : err instanceof ApiError && err.status === 400
            ? "Keys use lowercase letters, numbers and hyphens; both fields are required."
            : "Couldn't add. Try again.",
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="gcpe-admin__media-lists">
      <h1>Media list names</h1>
      <p>Changes reach News On Demand&rsquo;s media lists within a minute. Members are managed under Subscribers, Media lists.</p>
      {loadError && <InlineAlert variant="danger" role="alert" description={loadError} />}
      {message && <p role="status">{message}</p>}
      {rows === null && !loadError && <p>Loading…</p>}
      {rows && (
        <table aria-label="Media lists" className="gcpe-table">
          <thead>
            <tr>
              <th scope="col">Key</th>
              <th scope="col">Name</th>
              <th scope="col">Order</th>
              <th scope="col">Active</th>
              <th scope="col">Save</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <MediaListRow
                key={r.key}
                record={r}
                onSaved={(text) => {
                  setMessage(text);
                  reload();
                }}
              />
            ))}
          </tbody>
        </table>
      )}
      <h2>Add a media list</h2>
      <Form onSubmit={(e) => void onAdd(e)} aria-label="Add a media list" className="gcpe-field-row">
        <TextField label="Key" name="key" value={key} onChange={setKey} />
        <TextField label="Name" name="name" value={name} onChange={setName} />
        <Button type="submit" isDisabled={busy}>
          Add media list
        </Button>
      </Form>
      {addError && <InlineAlert variant="danger" role="alert" description={addError} />}
    </div>
  );
}

function MediaListRow({ record, onSaved }: { record: MediaListRecord; onSaved(text: string): void }): React.JSX.Element {
  const [name, setName] = useState(record.displayName);
  const [order, setOrder] = useState(String(record.sortOrder));
  const [active, setActive] = useState(record.isActive);
  const [confirmRetire, setConfirmRetire] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Checked before the retire dialog opens, so a typing mistake never surfaces behind it.
  // `Number("")` is 0, so an emptied Order field is caught as empty, not saved as 0.
  const problem = (): string | null => {
    if (order.trim() === "" || !Number.isInteger(Number(order))) return "Order must be a whole number.";
    if (!name.trim()) return "Name is required.";
    return null;
  };

  const save = async () => {
    const invalid = problem();
    if (invalid) return setError(invalid);
    const sortOrder = Number(order);
    setBusy(true);
    setError(null);
    try {
      await apiFetch(`/nrms/api/media-lists/${encodeURIComponent(record.key)}`, { method: "PUT", body: { displayName: name.trim(), sortOrder, isActive: active } });
      setConfirmRetire(false);
      onSaved(`${record.key} saved.`);
    } catch {
      setError("Couldn't save. Try again.");
    } finally {
      setBusy(false);
    }
  };

  const onSave = () => {
    if (!(record.isActive && !active)) return void save();
    const invalid = problem();
    setError(invalid);
    if (!invalid) setConfirmRetire(true);
  };
  const closeRetire = () => {
    setConfirmRetire(false);
    setError(null);
  };

  return (
    <tr>
      <td>{record.key}</td>
      <td>
        <TextField aria-label={`Name for ${record.key}`} value={name} onChange={setName} />
      </td>
      <td>
        <label>
          <span className="gcpe-visually-hidden">{`Order for ${record.key}`}</span>
          <input type="number" value={order} onChange={(e) => setOrder(e.target.value)} />
        </label>
      </td>
      <td>
        <label className="gcpe-check">
          <input type="checkbox" checked={active} onChange={() => setActive(!active)} />
          <span className="gcpe-visually-hidden">{`${record.key} active`}</span>
        </label>
      </td>
      <td>
        <Button variant="secondary" isDisabled={busy} onPress={onSave}>
          <span>
            Save <span className="gcpe-visually-hidden">{record.key}</span>
          </span>
        </Button>
        {error && !confirmRetire && <InlineAlert variant="danger" role="alert" description={error} />}
        {confirmRetire && (
          <Modal isOpen onOpenChange={(open) => { if (!open) closeRetire(); }} isDismissable>
            <AlertDialog
              role="alertdialog"
              variant="warning"
              title={`Retire ${record.key}?`}
              buttons={
                <>
                  <Button onPress={closeRetire} isDisabled={busy}>
                    Cancel
                  </Button>
                  <Button onPress={() => void save()} isDisabled={busy}>
                    Retire list
                  </Button>
                </>
              }
            >
              <p>Releases can no longer be sent to it. Its members are kept, and ticking Active again brings it back.</p>
              {error && <InlineAlert variant="danger" role="alert" description={error} />}
            </AlertDialog>
          </Modal>
        )}
      </td>
    </tr>
  );
}

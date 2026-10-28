import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { AlertDialog, Form, Modal, Radio, RadioGroup, TextField } from "@bcgov/design-system-react-components";
import type { TermRecord } from "@gcpe/events/catalogue";
import { apiFetch, ApiError } from "../../../api/client";
import { useSession } from "../../../session/SessionContext";
import { Button } from "../../../shared/BusyButton";
import { useDocumentTitle } from "../../../shared/useDocumentTitle";

type Kind = "sector" | "theme" | "tag";
const KINDS: { kind: Kind; plural: string; singular: string }[] = [
  { kind: "sector", plural: "Sectors", singular: "sector" },
  { kind: "theme", plural: "Themes", singular: "theme" },
  { kind: "tag", plural: "Tags", singular: "tag" },
];

const TITLE = "Sectors, themes and tags";
const KEY_FORMAT = "Keys use lowercase letters, numbers and hyphens (at most 100).";
const NAME_REQUIRED = "Name is required.";

/** Which field a save error belongs to, and what to tell the person (Task 1's codes arrive as the response's `error`). */
function explain(err: unknown): { field: "key" | "name" | "form"; text: string } {
  if (err instanceof ApiError) {
    if (err.status === 400 && err.message === "key-format") return { field: "key", text: KEY_FORMAT };
    if (err.status === 400 && err.message === "name-required") return { field: "name", text: NAME_REQUIRED };
    if (err.status === 400 && err.message === "name-too-long") return { field: "name", text: "Name is too long. Use at most 100 characters." };
    if (err.status === 409) return { field: "key", text: "That key is already used. To bring a retired one back, tick Active on its row." };
  }
  return { field: "form", text: "Couldn't save. Try again." };
}

/** A name's key suggestion: lowercase, anything outside [a-z0-9] collapsed to "-", trimmed of "-", at most 100. */
function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 100)
    .replace(/-+$/, "");
}

/** `/hub/categories`: owners edit the sectors, themes and tags the public site, subscribe page and
 * release editor offer. Core.Admin only, the role Core's term writes require. */
export function CategoriesScreen(): React.JSX.Element {
  useDocumentTitle(TITLE);
  if (!useSession().has("Core.Admin")) {
    return (
      <div className="gcpe-admin__categories">
        <h1>{TITLE}</h1>
        <p>You don't have permission to manage sectors, themes and tags.</p>
      </div>
    );
  }
  return <CategoriesEditor />;
}

function CategoriesEditor(): React.JSX.Element {
  const [kind, setKind] = useState<Kind>("sector");
  const [rows, setRows] = useState<TermRecord[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const labels = KINDS.find((k) => k.kind === kind)!;

  // Only the latest load may land: a slow earlier load (or another kind's) must not put back stale rows.
  const latest = useRef(0);
  const reload = useCallback((k: Kind) => {
    const seq = ++latest.current;
    apiFetch<TermRecord[]>(`/core/api/terms/${k}`).then(
      (r) => {
        if (seq !== latest.current) return;
        setRows(r);
        setLoadError(null);
      },
      () => {
        if (seq !== latest.current) return;
        setLoadError(`Couldn't load ${KINDS.find((x) => x.kind === k)!.plural.toLowerCase()}.`);
      },
    );
  }, []);
  useEffect(() => {
    setRows(null);
    setMessage(null);
    reload(kind);
  }, [kind, reload]);

  return (
    <div className="gcpe-admin__categories">
      <h1>{TITLE}</h1>
      <p>Changes reach the public site, the subscribe page and the release editor within a minute. A key is part of the public address and never changes.</p>
      <RadioGroup label="Show" orientation="horizontal" value={kind} onChange={(k) => setKind(k as Kind)}>
        {KINDS.map((k) => (
          <Radio key={k.kind} value={k.kind}>
            {k.plural}
          </Radio>
        ))}
      </RadioGroup>
      {loadError && <p role="alert">{loadError}</p>}
      <p role="status">{message}</p>
      {rows === null && !loadError && <p>Loading…</p>}
      {rows && (
        <table aria-label={labels.plural} className="gcpe-table">
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
              <TermRow
                key={`${kind}/${r.key}`}
                record={r}
                onSaved={(text) => {
                  setMessage(text);
                  reload(kind);
                }}
              />
            ))}
          </tbody>
        </table>
      )}
      <AddForm
        key={kind}
        kind={kind}
        singular={labels.singular}
        nextOrder={Math.max(0, ...(rows ?? []).map((r) => r.sortOrder)) + 1}
        ready={rows !== null}
        onAdded={(text) => {
          setMessage(text);
          reload(kind);
        }}
      />
    </div>
  );
}

function TermRow({ record, onSaved }: { record: TermRecord; onSaved(text: string): void }): React.JSX.Element {
  const [name, setName] = useState(record.displayName ?? "");
  const [order, setOrder] = useState(String(record.sortOrder));
  const [active, setActive] = useState(record.isActive);
  const [confirmRetire, setConfirmRetire] = useState(false);
  const [error, setError] = useState<{ field: "order" | "name" | "form"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const nameCell = useRef<HTMLTableCellElement>(null);
  const orderRef = useRef<HTMLInputElement>(null);
  const errorId = `term-error-${record.kind}-${record.key}`;

  // Checked before the retire dialog opens, so a typing mistake never surfaces behind it.
  // `Number("")` is 0, so an emptied Order field is caught as empty, not saved as 0.
  const problem = (): typeof error => {
    if (order.trim() === "" || !Number.isInteger(Number(order))) return { field: "order", text: "Order must be a whole number." };
    if (!name.trim()) return { field: "name", text: NAME_REQUIRED };
    return null;
  };
  const show = (e: NonNullable<typeof error>) => {
    setError(e);
    if (e.field === "order") orderRef.current?.focus();
    else if (e.field === "name") nameCell.current?.querySelector("input")?.focus();
  };

  const save = async () => {
    const invalid = problem();
    if (invalid) return show(invalid);
    setBusy(true);
    setError(null);
    try {
      // The loaded record goes back whole so `social` is kept as loaded.
      await apiFetch(`/core/api/terms/${record.kind}/${encodeURIComponent(record.key)}`, {
        method: "PUT",
        body: { ...record, displayName: name.trim(), sortOrder: Number(order), isActive: active },
      });
      setConfirmRetire(false);
      onSaved(`${record.key} saved.`);
    } catch (err) {
      const e = explain(err);
      show({ field: e.field === "key" ? "form" : e.field, text: e.text });
    } finally {
      setBusy(false);
    }
  };

  const onSave = () => {
    if (!(record.isActive && !active)) return void save();
    const invalid = problem();
    if (invalid) return show(invalid);
    setError(null);
    setConfirmRetire(true);
  };
  const closeRetire = () => {
    setConfirmRetire(false);
    setError(null);
  };
  const described = (field: string) => (error?.field === field && !confirmRetire ? errorId : undefined);

  return (
    <tr>
      <td>{record.key}</td>
      <td ref={nameCell}>
        <TextField
          aria-label={`Name for ${record.key}`}
          value={name}
          onChange={setName}
          isInvalid={error?.field === "name"}
          aria-describedby={described("name")}
        />
      </td>
      <td>
        <label>
          <span className="gcpe-visually-hidden">{`Order for ${record.key}`}</span>
          <input
            ref={orderRef}
            type="number"
            value={order}
            onChange={(e) => setOrder(e.target.value)}
            aria-invalid={error?.field === "order" || undefined}
            aria-describedby={described("order")}
          />
        </label>
      </td>
      <td>
        <label className="gcpe-check">
          <input type="checkbox" checked={active} onChange={() => setActive(!active)} />
          <span className="gcpe-visually-hidden">{`${record.key} active`}</span>
        </label>
      </td>
      <td>
        <Button variant="secondary" isPending={busy} onPress={onSave}>
          <span>
            Save <span className="gcpe-visually-hidden">{record.key}</span>
          </span>
        </Button>
        {error && !confirmRetire && (
          <p role="alert" id={errorId}>
            {error.text}
          </p>
        )}
        {confirmRetire && (
          <Modal isOpen onOpenChange={(open) => { if (!open) closeRetire(); }} isDismissable>
            <AlertDialog
              role="alertdialog"
              variant="warning"
              title={`Retire ${name.trim() || record.key}?`}
              buttons={
                <>
                  <Button onPress={closeRetire} isPending={busy}>
                    Cancel
                  </Button>
                  <Button onPress={() => void save()} isPending={busy}>
                    Retire
                  </Button>
                </>
              }
            >
              <p>It leaves the public site's lists, the subscribe page and the release editor's choices. Releases already tagged keep it.</p>
              {error && <p role="alert">{error.text}</p>}
            </AlertDialog>
          </Modal>
        )}
      </td>
    </tr>
  );
}

function AddForm({ kind, singular, nextOrder, ready, onAdded }: { kind: Kind; singular: string; nextOrder: number; ready: boolean; onAdded(text: string): void }): React.JSX.Element {
  const [name, setName] = useState("");
  const [key, setKey] = useState("");
  const [keyEdited, setKeyEdited] = useState(false);
  const [error, setError] = useState<{ field: "key" | "name" | "form"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const formEl = useRef<HTMLFormElement | null>(null);

  const fail = (e: NonNullable<typeof error>) => {
    setError(e);
    if (e.field !== "form") formEl.current?.querySelector<HTMLInputElement>(`input[name="${e.field}"]`)?.focus();
  };

  const onSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    formEl.current = e.currentTarget;
    if (!name.trim()) return fail({ field: "name", text: NAME_REQUIRED });
    if (!key.trim()) return fail({ field: "key", text: KEY_FORMAT });
    setBusy(true);
    setError(null);
    const newKey = key.trim();
    try {
      await apiFetch(`/core/api/terms/${kind}/${encodeURIComponent(newKey)}`, {
        method: "PUT",
        body: {
          kind,
          key: newKey,
          displayName: name.trim(),
          sortOrder: nextOrder,
          isActive: true,
          social: { twitterUsername: null, flickrUrl: null, youtubeUrl: null, audioUrl: null },
        },
      });
      setName("");
      setKey("");
      setKeyEdited(false);
      onAdded(`Added ${name.trim()} (${newKey}).`);
    } catch (err) {
      fail(explain(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <h2>{`Add a ${singular}`}</h2>
      <Form onSubmit={(e) => void onSubmit(e)} aria-label={`Add a ${singular}`} className="gcpe-field-row">
        <TextField
          label="Name"
          name="name"
          value={name}
          isInvalid={error?.field === "name"}
          aria-describedby={error?.field === "name" ? "category-add-error" : undefined}
          onChange={(v) => {
            setName(v);
            if (!keyEdited) setKey(slugify(v));
          }}
        />
        <TextField
          label="Key"
          name="key"
          value={key}
          isInvalid={error?.field === "key"}
          aria-describedby={error?.field === "key" ? "category-add-error" : undefined}
          onChange={(v) => {
            setKey(v);
            setKeyEdited(true);
          }}
        />
        <Button type="submit" isPending={busy} isDisabled={!ready} pendingLabel="Adding…">
          {`Add ${singular}`}
        </Button>
      </Form>
      {error && (
        <p role="alert" id="category-add-error">
          {error.text}
        </p>
      )}
    </>
  );
}

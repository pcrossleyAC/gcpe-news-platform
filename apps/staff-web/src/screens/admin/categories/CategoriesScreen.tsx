import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from "react";
import { AlertDialog, Form, Modal, Radio, RadioGroup, TextField } from "@bcgov/design-system-react-components";
import type { TermRecord } from "@gcpe/events/catalogue";
import { apiFetch, ApiError } from "../../../api/client";
import { useSession } from "../../../session/SessionContext";
import { Button } from "../../../shared/BusyButton";
import { useDocumentTitle } from "../../../shared/useDocumentTitle";
import { TableScroll } from "../../../shared/TableScroll";
import { useShortcut } from "../../../shared/shortcuts";

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
    if (err.status === 400 && err.message === "name-too-long") return { field: "name", text: "Name is too long (at most 100 characters)." };
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

type RowField = "order" | "name" | "form";
type RowError = { field: RowField; text: string };
/** A row's three editable values, as typed. */
interface Draft {
  name: string;
  order: string;
  active: boolean;
}
/** An edited row: the record as loaded (it goes back whole, so `social` is kept) and what's typed. */
interface Edit {
  record: TermRecord;
  draft: Draft;
}

const idOf = (r: TermRecord) => `${r.kind}/${r.key}`;
const draftOf = (r: TermRecord): Draft => ({ name: r.displayName ?? "", order: String(r.sortOrder), active: r.isActive });
const sameDraft = (a: Draft, b: Draft) => a.name === b.name && a.order === b.order && a.active === b.active;
const rowsText = (n: number) => `${n} ${n === 1 ? "row" : "rows"}`;

/** Sectors, then themes, then tags; each in the order the table lists them. */
const inTableOrder = (list: Edit[]) =>
  [...list].sort(
    (a, b) =>
      KINDS.findIndex((k) => k.kind === a.record.kind) - KINDS.findIndex((k) => k.kind === b.record.kind) ||
      a.record.sortOrder - b.record.sortOrder ||
      a.record.key.localeCompare(b.record.key),
  );

/** What's wrong with a row as typed, checked before anything is sent. `Number("")` is 0, so an
 * emptied Order field is caught as empty, not saved as 0. */
function problemOf(d: Draft): RowError | null {
  if (d.order.trim() === "" || !Number.isInteger(Number(d.order))) return { field: "order", text: "Order must be a whole number." };
  if (!d.name.trim()) return { field: "name", text: NAME_REQUIRED };
  return null;
}

/**
 * The grid has one Save (owner decision 2026-10-29), not one per row. Edits live here, by row
 * (kind/key), so they survive switching Show; each edited row is marked Unsaved. "Save changes"
 * checks every edited row first (a typing mistake is shown on its row and nothing is sent), asks
 * once before retiring any, then sends each row's PUT in turn. Core's term writes are one row
 * each with no version, so a row that fails doesn't stop the others: it keeps its edit and shows
 * why; the rows that saved are cleared and the table reloads.
 */
function CategoriesEditor(): React.JSX.Element {
  const [kind, setKind] = useState<Kind>("sector");
  const [rows, setRows] = useState<TermRecord[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [edits, setEdits] = useState<ReadonlyMap<string, Edit>>(new Map());
  const [errors, setErrors] = useState<ReadonlyMap<string, RowError>>(new Map());
  const [saving, setSaving] = useState(false);
  const [retiring, setRetiring] = useState<Edit[] | null>(null);
  const savingRef = useRef(false);
  const fields = useRef(new Map<string, { name: HTMLInputElement | null; order: HTMLInputElement | null }>());
  const labels = KINDS.find((k) => k.kind === kind)!;
  const kindRef = useRef(kind);
  kindRef.current = kind;

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

  const change = (record: TermRecord, draft: Draft) => {
    const id = idOf(record);
    setEdits((prev) => {
      const next = new Map(prev);
      if (sameDraft(draft, draftOf(record))) next.delete(id);
      else next.set(id, { record: prev.get(id)?.record ?? record, draft });
      return next;
    });
  };

  const focusField = (id: string, field: RowField) => {
    const f = fields.current.get(id);
    if (field === "order") f?.order?.focus();
    else if (field === "name") f?.name?.focus();
  };

  const send = async (pending: Edit[]) => {
    savingRef.current = true;
    setSaving(true);
    const failed = new Map<string, RowError>();
    // Each saved row with the draft that was sent: a row typed into while saving keeps its newer edit.
    const saved: { id: string; draft: Draft }[] = [];
    for (const { record, draft } of pending) {
      try {
        await apiFetch(`/core/api/terms/${record.kind}/${encodeURIComponent(record.key)}`, {
          method: "PUT",
          body: { ...record, displayName: draft.name.trim(), sortOrder: Number(draft.order), isActive: draft.active },
        });
        saved.push({ id: idOf(record), draft });
      } catch (err) {
        const e = explain(err);
        failed.set(idOf(record), { field: e.field === "key" ? "form" : e.field, text: e.text });
      }
    }
    setEdits((prev) => {
      const next = new Map(prev);
      for (const { id, draft } of saved) {
        const now = next.get(id);
        if (now && sameDraft(now.draft, draft)) next.delete(id);
      }
      return next;
    });
    setErrors(failed);
    setMessage(
      [saved.length > 0 ? `Saved ${saved.length} ${saved.length === 1 ? "change" : "changes"}.` : "", failed.size > 0 ? `${rowsText(failed.size)} couldn't be saved — see the message on ${failed.size === 1 ? "that row" : "those rows"}.` : ""]
        .filter(Boolean)
        .join(" "),
    );
    savingRef.current = false;
    setSaving(false);
    if (saved.length > 0) reload(kindRef.current);
    const first = [...failed.entries()].find(([id]) => id.startsWith(`${kindRef.current}/`));
    if (first) focusField(first[0], first[1].field);
  };

  const saveChanges = () => {
    if (savingRef.current) return;
    const pending = inTableOrder([...edits.values()]);
    if (pending.length === 0) {
      setMessage("No changes to save.");
      return;
    }
    const invalid = new Map<string, RowError>();
    for (const e of pending) {
      const problem = problemOf(e.draft);
      if (problem) invalid.set(idOf(e.record), problem);
    }
    setErrors(invalid);
    if (invalid.size > 0) {
      setMessage(null);
      const first = [...invalid.entries()].find(([id]) => id.startsWith(`${kind}/`)) ?? [...invalid.entries()][0]!;
      focusField(first[0], first[1].field);
      return;
    }
    const toRetire = pending.filter((e) => e.record.isActive && !e.draft.active);
    if (toRetire.length > 0) {
      setRetiring(toRetire);
      return;
    }
    void send(pending);
  };
  // ⌘/Ctrl+S is the grid's Save changes, from anywhere on the screen (not while the retire dialog asks).
  useShortcut("save", saveChanges);

  const confirmRetire = () => {
    setRetiring(null);
    void send(inTableOrder([...edits.values()]));
  };

  const elsewhere = KINDS.filter((k) => k.kind !== kind)
    .map((k) => ({ plural: k.plural, n: [...edits.keys()].filter((id) => id.startsWith(`${k.kind}/`)).length }))
    .filter((k) => k.n > 0);
  const unsavedText =
    edits.size === 0
      ? null
      : `${rowsText(edits.size)} ${edits.size === 1 ? "has" : "have"} unsaved changes${elsewhere.length > 0 ? ` (${elsewhere.map((k) => `${k.n} in ${k.plural}`).join(", ")})` : ""}.`;
  const retireName = (e: Edit) => e.draft.name.trim() || e.record.key;

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
        <TableScroll label={labels.plural}>
          <table aria-label={labels.plural} className="gcpe-table">
            <thead>
              <tr>
                <th scope="col">Key</th>
                <th scope="col">Name</th>
                <th scope="col">Order</th>
                <th scope="col">Active</th>
                <th scope="col">Changes</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const id = idOf(r);
                const edit = edits.get(id);
                return (
                  <TermRow
                    key={`${kind}/${r.key}`}
                    record={r}
                    draft={edit?.draft ?? draftOf(r)}
                    dirty={edit !== undefined}
                    error={errors.get(id) ?? null}
                    onChange={(d) => change(r, d)}
                    fieldRefs={(f) => {
                      fields.current.set(id, f);
                    }}
                  />
                );
              })}
            </tbody>
          </table>
        </TableScroll>
      )}
      <div className="gcpe-admin__save-row">
        <Button onPress={saveChanges} isPending={saving} pendingLabel="Saving…" shortcut="save">
          Save changes
        </Button>
        {unsavedText && <p className="gcpe-hint">{unsavedText}</p>}
      </div>
      {retiring && (
        <Modal isOpen onOpenChange={(open) => { if (!open) setRetiring(null); }} isDismissable>
          <AlertDialog
            role="alertdialog"
            variant="warning"
            title={retiring.length === 1 ? `Retire ${retireName(retiring[0]!)}?` : `Retire ${retiring.length} entries?`}
            buttons={
              <>
                <Button onPress={() => setRetiring(null)}>Cancel</Button>
                <Button onPress={confirmRetire}>Retire</Button>
              </>
            }
          >
            {retiring.length > 1 && (
              <ul>
                {retiring.map((e) => (
                  <li key={idOf(e.record)}>{retireName(e)}</li>
                ))}
              </ul>
            )}
            <p>
              {retiring.length === 1 ? "It leaves" : "They leave"} the public site's lists, the subscribe page and the release editor's choices. Releases already tagged keep {retiring.length === 1 ? "it" : "them"}.
            </p>
            <p>Your other changes are saved with {retiring.length === 1 ? "it" : "them"}.</p>
          </AlertDialog>
        </Modal>
      )}
      <AddForm
        key={kind}
        kind={kind}
        singular={labels.singular}
        nextOrder={Math.max(0, ...(rows ?? []).map((r) => r.sortOrder)) + 1}
        ready={rows !== null}
        onAdded={(text) => {
          if (kindRef.current !== kind) return;
          setMessage(text);
          reload(kind);
        }}
      />
    </div>
  );
}

interface TermRowProps {
  record: TermRecord;
  draft: Draft;
  dirty: boolean;
  error: RowError | null;
  onChange(draft: Draft): void;
  fieldRefs(fields: { name: HTMLInputElement | null; order: HTMLInputElement | null }): void;
}

function TermRow({ record, draft, dirty, error, onChange, fieldRefs }: TermRowProps): React.JSX.Element {
  const nameCell = useRef<HTMLTableCellElement>(null);
  const orderRef = useRef<HTMLInputElement>(null);
  const errorId = `term-error-${useId()}`;
  useEffect(() => {
    fieldRefs({ name: nameCell.current?.querySelector("input") ?? null, order: orderRef.current });
  });
  const described = (field: RowField) => (error?.field === field ? errorId : undefined);

  return (
    <tr>
      <td>{record.key}</td>
      <td ref={nameCell}>
        <TextField
          aria-label={`Name for ${record.key}`}
          value={draft.name}
          onChange={(name) => onChange({ ...draft, name })}
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
            value={draft.order}
            onChange={(e) => onChange({ ...draft, order: e.target.value })}
            aria-invalid={error?.field === "order" || undefined}
            aria-describedby={described("order")}
          />
        </label>
      </td>
      <td>
        <label className="gcpe-check">
          <input type="checkbox" checked={draft.active} onChange={() => onChange({ ...draft, active: !draft.active })} />
          <span className="gcpe-visually-hidden">{`${record.key} active`}</span>
        </label>
      </td>
      <td>
        {dirty && <span className="gcpe-unsaved-marker">Unsaved</span>}
        {error && (
          <p role="alert" id={errorId}>
            {error.text}
          </p>
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
  const addErrorId = `category-add-error-${useId()}`;
  const inFlight = useRef(false);
  const formEl = useRef<HTMLFormElement | null>(null);

  const fail = (e: NonNullable<typeof error>) => {
    setError(e);
    if (e.field !== "form") formEl.current?.querySelector<HTMLInputElement>(`input[name="${e.field}"]`)?.focus();
  };

  const onSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (inFlight.current) return;
    formEl.current = e.currentTarget;
    if (!name.trim()) return fail({ field: "name", text: NAME_REQUIRED });
    if (!key.trim()) return fail({ field: "key", text: KEY_FORMAT });
    inFlight.current = true;
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
      inFlight.current = false;
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
          aria-describedby={error?.field === "name" ? addErrorId : undefined}
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
          aria-describedby={error?.field === "key" ? addErrorId : undefined}
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
        <p role="alert" id={addErrorId}>
          {error.text}
        </p>
      )}
    </>
  );
}

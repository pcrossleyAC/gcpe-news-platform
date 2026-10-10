import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router";
import { Button, InlineAlert } from "@bcgov/design-system-react-components";
import { apiFetch } from "../../../api/client";
import { useDocumentTitle } from "../../../shared/useDocumentTitle";
import { messagesOf } from "../../admin/messages";
import { withArticle, type LookupDetail, type LookupRowView, type LookupSummary } from "./types";

interface Draft {
  name: string;
  extras: Record<string, string>;
  isActive: boolean;
}

function RowForm({ lookup, row, label, submitLabel, onSubmit, onCancel }: {
  lookup: LookupSummary;
  row: LookupRowView | null;
  label: string;
  submitLabel: string;
  onSubmit(draft: Draft): Promise<void>;
  onCancel?(): void;
}): React.JSX.Element {
  const [draft, setDraft] = useState<Draft>({
    name: row?.name ?? "",
    extras: Object.fromEntries(lookup.extras.map((e) => [e.key, row?.extras[e.key] ?? ""])),
    isActive: row?.isActive ?? true,
  });
  const [messages, setMessages] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const idBase = `lookup-${lookup.name}-${row?.id ?? "new"}`;
  const submit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setBusy(true);
    setMessages([]);
    try {
      await onSubmit(draft);
      if (!row) setDraft({ name: "", extras: Object.fromEntries(lookup.extras.map((x) => [x.key, ""])), isActive: true });
    } catch (caught) {
      setMessages(messagesOf(caught));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form aria-label={label} onSubmit={submit}>
      {messages.map((m) => (
        <p role="alert" key={m}>
          {m}
        </p>
      ))}
      <label htmlFor={`${idBase}-name`}>Name</label>
      <input id={`${idBase}-name`} value={draft.name} maxLength={lookup.nameMax} onChange={(e) => setDraft({ ...draft, name: e.target.value })} disabled={busy} required />
      {lookup.extras.map((x) => (
        <div key={x.key}>
          <label htmlFor={`${idBase}-${x.key}`}>{x.label}</label>
          <input id={`${idBase}-${x.key}`} value={draft.extras[x.key] ?? ""} maxLength={x.max} onChange={(e) => setDraft({ ...draft, extras: { ...draft.extras, [x.key]: e.target.value } })} disabled={busy} />
        </div>
      ))}
      {row && (
        <div>
          <input id={`${idBase}-active`} type="checkbox" checked={draft.isActive} onChange={(e) => setDraft({ ...draft, isActive: e.target.checked })} disabled={busy} />
          <label htmlFor={`${idBase}-active`}>Active</label>
        </div>
      )}
      <Button type="submit" isDisabled={busy}>
        {submitLabel}
      </Button>
      {onCancel && (
        <Button variant="secondary" onPress={onCancel} isDisabled={busy}>
          Cancel
        </Button>
      )}
    </form>
  );
}

/** `/hub/calendar/lookups/:name`: one lookup's rows (spec addendum §5.3). */
export function LookupScreen(): React.JSX.Element {
  const { name = "" } = useParams();
  const [lookup, setLookup] = useState<LookupDetail | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [orderMessages, setOrderMessages] = useState<string[]>([]);
  const [editing, setEditing] = useState<number | null>(null);
  const latest = useRef(0);
  useDocumentTitle(lookup?.label ?? null);

  const reload = useCallback(() => {
    const call = ++latest.current;
    apiFetch<LookupDetail>(`/calendar/api/lookups/${encodeURIComponent(name)}`).then(
      (l) => {
        if (call === latest.current) setLookup(l);
      },
      () => {
        if (call === latest.current) setLoadError("Couldn't load this lookup.");
      },
    );
  }, [name]);
  useEffect(() => reload(), [reload]);

  if (loadError) return <InlineAlert variant="danger" role="alert" description={loadError} />;
  if (!lookup) return <p>Loading…</p>;

  const body = (d: Draft) => ({ name: d.name, extras: Object.fromEntries(lookup.extras.map((x) => [x.key, d.extras[x.key] ?? ""])) });
  const add = async (d: Draft) => {
    const created = await apiFetch<LookupRowView>(`/calendar/api/lookups/${lookup.name}`, { method: "POST", body: body(d) });
    setStatus(`Added ${created.name}.`);
    reload();
  };
  const save = (row: LookupRowView) => async (d: Draft) => {
    const saved = await apiFetch<LookupRowView>(`/calendar/api/lookups/${lookup.name}/${row.id}`, { method: "PUT", body: { ...body(d), isActive: d.isActive } });
    setEditing(null);
    setStatus(`Saved ${saved.name}.`);
    reload();
  };
  const move = async (index: number, by: -1 | 1) => {
    const ids = lookup.rows.map((r) => r.id);
    const [moved] = ids.splice(index, 1);
    ids.splice(index + by, 0, moved!);
    setOrderMessages([]);
    try {
      await apiFetch(`/calendar/api/lookups/${lookup.name}/order`, { method: "PUT", body: { ids } });
      setStatus(`Moved ${lookup.rows[index]!.name} ${by < 0 ? "up" : "down"}.`);
    } catch (caught) {
      setOrderMessages(messagesOf(caught));
    }
    reload();
  };

  return (
    <div>
      <p>
        <Link to="/calendar/lookups">All lookups</Link>
      </p>
      <h1>{lookup.label}</h1>
      {!lookup.editable && <p>Only a System Administrator can change {lookup.label.toLowerCase()}.</p>}
      {status && <p role="status">{status}</p>}
      {orderMessages.map((m) => (
        <p role="alert" key={m}>
          {m}
        </p>
      ))}
      <table>
        <caption>{lookup.label}</caption>
        <thead>
          <tr>
            <th scope="col">Name</th>
            {lookup.extras.map((x) => (
              <th scope="col" key={x.key}>
                {x.label}
              </th>
            ))}
            <th scope="col">Status</th>
            {lookup.editable && <th scope="col">Actions</th>}
          </tr>
        </thead>
        <tbody>
          {lookup.rows.map((r, i) => (
            <tr key={r.id}>
              <td>{r.name}</td>
              {lookup.extras.map((x) => (
                <td key={x.key}>{r.extras[x.key] ?? ""}</td>
              ))}
              <td>{r.isActive ? "Active" : "Inactive"}</td>
              {lookup.editable && (
                <td>
                  {editing === r.id ? (
                    <RowForm lookup={lookup} row={r} label={`Edit ${r.name}`} submitLabel="Save" onSubmit={save(r)} onCancel={() => setEditing(null)} />
                  ) : (
                    <>
                      <Button variant="secondary" onPress={() => setEditing(r.id)}>{`Edit ${r.name}`}</Button>
                      {i > 0 && <Button variant="tertiary" onPress={() => void move(i, -1)}>{`Move ${r.name} up`}</Button>}
                      {i < lookup.rows.length - 1 && <Button variant="tertiary" onPress={() => void move(i, 1)}>{`Move ${r.name} down`}</Button>}
                    </>
                  )}
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
      {lookup.editable && (
        <>
          <h2>Add {withArticle(lookup.singular)}</h2>
          <RowForm lookup={lookup} row={null} label={`Add ${withArticle(lookup.singular)}`} submitLabel="Add" onSubmit={add} />
        </>
      )}
    </div>
  );
}

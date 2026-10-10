import { useEffect, useRef, useState } from "react";
import { Button, InlineAlert } from "@bcgov/design-system-react-components";
import type { ListFilter, SavedFilterView } from "@gcpe/calendar-contract";
import { ApiError } from "../../../api/client";
import { messagesOf } from "../../admin/messages";
import { listApi } from "./api";

/** "My Queries" (Default.aspx:663-681): your own saved filters. Saving isn't frozen. */
export function MyQueries({ current, onRun }: { current: ListFilter; onRun: (filter: ListFilter) => void }): React.JSX.Element {
  const [filters, setFilters] = useState<SavedFilterView[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [editing, setEditing] = useState<number | null>(null);
  const [editName, setEditName] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const latest = useRef(0);

  const load = () => {
    const call = ++latest.current;
    listApi.savedFilters().then(
      (f) => call === latest.current && setFilters(f),
      () => call === latest.current && setLoadError("Couldn't load your queries."),
    );
  };
  useEffect(load, []);

  const act = async (work: () => Promise<string>) => {
    setErrors([]);
    setStatus(null);
    try {
      setStatus(await work());
    } catch (caught) {
      const stale = caught instanceof ApiError && (caught.status === 409 || caught.status === 404);
      setErrors(stale ? ["Your queries changed in another tab, so they were reloaded."] : messagesOf(caught));
      if (stale) load();
    }
  };
  const save = () =>
    act(async () => {
      const f = await listApi.saveFilter(name.trim(), current);
      setFilters((xs) => [...(xs ?? []), f]);
      setName("");
      return `Saved the query “${f.name}”.`;
    });
  const rename = (f: SavedFilterView) =>
    act(async () => {
      const r = await listApi.renameFilter(f.id, editName.trim());
      setFilters((xs) => (xs ?? []).map((x) => (x.id === r.id ? r : x)));
      setEditing(null);
      return `Renamed to “${r.name}”.`;
    });
  const move = (index: number, delta: -1 | 1) =>
    act(async () => {
      const list = filters ?? [];
      const ids = list.map((f) => f.id);
      [ids[index], ids[index + delta]] = [ids[index + delta]!, ids[index]!];
      setFilters(await listApi.reorderFilters(ids));
      return `Moved “${list[index]!.name}” ${delta < 0 ? "up" : "down"}.`;
    });
  const remove = (f: SavedFilterView) =>
    act(async () => {
      await listApi.deleteFilter(f.id);
      setFilters((xs) => (xs ?? []).filter((x) => x.id !== f.id));
      return `Deleted the query “${f.name}”.`;
    });

  return (
    <section aria-labelledby="my-queries-heading" className="gcpe-my-queries">
      <h2 id="my-queries-heading">My Queries</h2>
      {status && <p role="status">{status}</p>}
      {errors.map((m, i) => (
        <p role="alert" key={`${i}:${m}`}>
          {m}
        </p>
      ))}
      {loadError ? (
        <InlineAlert variant="danger" role="alert" description={loadError} />
      ) : filters === null ? (
        <p>Loading…</p>
      ) : filters.length === 0 ? (
        <p>Use the filter above, then save it here.</p>
      ) : (
        <ul>
          {filters.map((f, i) => (
            <li key={f.id}>
              {editing === f.id ? (
                <form
                  aria-label={`Rename ${f.name}`}
                  onSubmit={(e) => {
                    e.preventDefault();
                    void rename(f);
                  }}
                >
                  <label htmlFor={`query-name-${f.id}`}>New name</label>
                  <input id={`query-name-${f.id}`} maxLength={200} value={editName} onChange={(e) => setEditName(e.target.value)} />
                  <Button type="submit" isDisabled={!editName.trim()}>
                    Save name
                  </Button>
                  <Button variant="tertiary" onPress={() => setEditing(null)}>
                    Cancel
                  </Button>
                </form>
              ) : (
                <>
                  <Button variant="tertiary" isDisabled={f.filter === null} onPress={() => f.filter && onRun(f.filter)}>
                    {f.name}
                  </Button>
                  {f.filter === null && <span className="gcpe-hint">This query can no longer be read. Delete it.</span>}
                  <Button
                    variant="tertiary"
                    aria-label={`Rename ${f.name}`}
                    onPress={() => {
                      setEditing(f.id);
                      setEditName(f.name);
                    }}
                  >
                    Rename
                  </Button>
                  <Button variant="tertiary" aria-label={`Move ${f.name} up`} isDisabled={i === 0} onPress={() => void move(i, -1)}>
                    Up
                  </Button>
                  <Button variant="tertiary" aria-label={`Move ${f.name} down`} isDisabled={i === filters.length - 1} onPress={() => void move(i, 1)}>
                    Down
                  </Button>
                  <Button variant="tertiary" aria-label={`Delete ${f.name}`} onPress={() => void remove(f)}>
                    Delete
                  </Button>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
      <form
        aria-label="Save this filter"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <label htmlFor="query-name">Name for this filter</label>
        <input id="query-name" maxLength={200} value={name} onChange={(e) => setName(e.target.value)} />
        <Button type="submit" isDisabled={!name.trim()}>
          Save query
        </Button>
      </form>
    </section>
  );
}

import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router";
import { Button, InlineAlert } from "@bcgov/design-system-react-components";
import { apiFetch, ApiError } from "../../api/client";
import { useSession } from "../../session/SessionContext";
import { useDocumentTitle } from "../../shared/useDocumentTitle";
import { moveBy } from "../../shared/reorder";
import { canAdminSubscribers } from "./access";
import type { StaffCategory, StaffListsView } from "./types";

function saveErrorText(e: unknown): string {
  if (e instanceof ApiError && e.status === 409 && e.message === "order-out-of-date") return "The lists changed while you were looking. They've been reloaded; try again.";
  if (e instanceof ApiError && e.status === 409 && e.message === "managed-in-nrms") return "Media lists are managed in NRMS.";
  return "Couldn't save. Try again.";
}

/** `/hub/subscribers/lists` (legacy ManageLists/ManageListCategories): every category and list
 * with its active subscriber count. NoD Admins choose what's offered and the order; list names
 * come from Core or NRMS and are read-only. Changes apply at once: they're reversible, and no
 * one's subscription is removed or stops being sent. */
export function ListsScreen(): React.JSX.Element {
  useDocumentTitle("Lists and categories");
  const canAdmin = canAdminSubscribers(useSession());
  const [view, setView] = useState<StaffListsView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const reload = useCallback(() => {
    apiFetch<StaffListsView>("/nod/api/list-categories").then(
      (v) => {
        setView(v);
        setLoadError(null);
      },
      () => setLoadError("Couldn't load lists."),
    );
  }, []);
  useEffect(() => reload(), [reload]);

  const save = async (path: string, body: unknown, done: string) => {
    setBusy(true);
    setSaveError(null);
    setMessage(null);
    try {
      await apiFetch(path, { method: "PUT", body });
      setMessage(done);
    } catch (e) {
      setSaveError(saveErrorText(e));
    } finally {
      setBusy(false);
      reload();
    }
  };

  const moveCategory = (index: number, delta: 1 | -1) => {
    const keys = moveBy(view!.categories.map((c) => c.key), index, delta);
    const name = view!.categories[index]!.name;
    void save("/nod/api/list-categories/order", { keys }, `${name} moved ${delta < 0 ? "up" : "down"}.`);
  };
  const moveList = (c: StaffCategory, index: number, delta: 1 | -1) => {
    const listKeys = moveBy(c.lists.map((l) => l.listKey), index, delta);
    void save(`/nod/api/list-categories/${encodeURIComponent(c.key)}/list-order`, { listKeys }, `${c.lists[index]!.name} moved ${delta < 0 ? "up" : "down"}.`);
  };

  return (
    <div className="gcpe-subscribers__lists">
      <h1>Lists and categories</h1>
      {loadError && <InlineAlert variant="danger" role="alert" description={loadError} />}
      {saveError && <InlineAlert variant="danger" role="alert" description={saveError} />}
      {message && <p role="status">{message}</p>}
      {view && <p>{`All news: ${view.allNews} active ${view.allNews === 1 ? "subscriber" : "subscribers"}.`}</p>}
      {view?.categories.map((c, ci) => (
        <section key={c.key} aria-labelledby={`category-${c.key}`}>
          <h2 id={`category-${c.key}`}>{c.name}</h2>
          {c.editable ? (
            <p>
              {`Names come from ${c.namesFrom}.`}
              {!c.enabled && " Not offered to subscribers."}
            </p>
          ) : (
            <p>
              Names, order and status come from NRMS (<Link to="/media-list-names">Media list names</Link>).
            </p>
          )}
          {canAdmin && (
            <div className="gcpe-subscribers__lists-controls">
              {c.editable && (
                <label>
                  <input
                    type="checkbox"
                    checked={c.enabled}
                    disabled={busy}
                    onChange={() => void save(`/nod/api/list-categories/${encodeURIComponent(c.key)}`, { enabled: !c.enabled }, `${c.name} ${c.enabled ? "is no longer offered" : "is offered again"}.`)}
                  />{" "}
                  {`Offer ${c.name}`}
                </label>
              )}
              <Button variant="secondary" isDisabled={busy || ci === 0} onPress={() => moveCategory(ci, -1)}>
                {`Move ${c.name} up`}
              </Button>
              <Button variant="secondary" isDisabled={busy || ci === view.categories.length - 1} onPress={() => moveCategory(ci, 1)}>
                {`Move ${c.name} down`}
              </Button>
            </div>
          )}
          {c.lists.length === 0 ? (
            <p>No lists yet.</p>
          ) : (
            <table aria-label={`${c.name} lists`}>
              <thead>
                <tr>
                  <th scope="col">List</th>
                  <th scope="col">Active subscribers</th>
                  <th scope="col">Offered</th>
                  {canAdmin && c.editable && <th scope="col">Order</th>}
                </tr>
              </thead>
              <tbody>
                {c.lists.map((l, li) => (
                  <tr key={l.listKey}>
                    <td>
                      {l.name}
                      {!l.active && ` (retired in ${c.namesFrom})`}
                    </td>
                    <td>{l.subscribers}</td>
                    <td>
                      {canAdmin && c.editable ? (
                        <label>
                          <input
                            type="checkbox"
                            checked={l.enabled}
                            disabled={busy}
                            onChange={() => void save(`/nod/api/lists/${encodeURIComponent(l.listKey)}`, { enabled: !l.enabled }, `${l.name} ${l.enabled ? "is no longer offered" : "is offered again"}.`)}
                          />{" "}
                          {`Offer ${l.name}`}
                        </label>
                      ) : l.enabled ? (
                        "Yes"
                      ) : (
                        "No"
                      )}
                    </td>
                    {canAdmin && c.editable && (
                      <td>
                        <Button variant="secondary" isDisabled={busy || li === 0} onPress={() => moveList(c, li, -1)}>
                          {`Move ${l.name} up`}
                        </Button>
                        <Button variant="secondary" isDisabled={busy || li === c.lists.length - 1} onPress={() => moveList(c, li, 1)}>
                          {`Move ${l.name} down`}
                        </Button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      ))}
    </div>
  );
}

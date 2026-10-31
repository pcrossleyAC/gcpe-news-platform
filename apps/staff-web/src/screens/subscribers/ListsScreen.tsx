import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import { InlineAlert } from "@bcgov/design-system-react-components";
import { apiFetch, ApiError } from "../../api/client";
import { useSession } from "../../session/SessionContext";
import { Button } from "../../shared/BusyButton";
import { TableScroll } from "../../shared/TableScroll";
import { useDocumentTitle } from "../../shared/useDocumentTitle";
import { moveBy } from "../../shared/reorder";
import { isCoreAdmin } from "../admin/organizations/access";
import { canAdminSubscribers } from "./access";
import type { StaffCategory, StaffList, StaffListsView } from "./types";

const MEDIA_LISTS_TEXT = "Media lists aren't changed here. Core administrators set these on Media list names.";

/** Where a category's names are set, in staff words (never the internal app names). */
const NAMES_SET_BY: Record<StaffCategory["namesFrom"], string> = {
  Core: "Names are set by Core administrators.",
  NRMS: "Names are set by Core administrators on Media list names.",
  NoD: "Names are set by News On Demand.",
};

function saveErrorText(e: unknown): string {
  if (e instanceof ApiError && e.status === 409 && e.message === "order-out-of-date") return "The lists changed while you were looking. They've been reloaded; try again.";
  if (e instanceof ApiError && e.status === 409 && e.message === "managed-in-nrms") return MEDIA_LISTS_TEXT;
  return "Couldn't save. Try again.";
}

/** Whether the public and the staff preferences form are offered `l` (active, switched on, and
 * in a category that's switched on), and if not, the reason staff can't see from the checkbox
 * alone. Media lists are never offered publicly; Core administrators set them on Media list names. */
function offeredText(c: StaffCategory, l: StaffList): string {
  if (!c.editable) return "No (media list)";
  if (!l.enabled) return "No";
  if (!l.active) return "No (retired)";
  if (!c.enabled) return "No (category not offered)";
  return "Yes";
}

/** `/hub/subscribers/lists` (legacy ManageLists/ManageListCategories): every category and list
 * with its active subscriber count. NoD Admins choose what's offered and the order; list names
 * come from Core or NRMS and are read-only. Changes apply at once: they're reversible, and no
 * one's subscription is removed or stops being sent. */
export function ListsScreen(): React.JSX.Element {
  useDocumentTitle("Lists and categories");
  const session = useSession();
  const canAdmin = canAdminSubscribers(session);
  const [view, setView] = useState<StaffListsView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // The last Offer checkbox change: "Saved", or what went wrong, shown beside that checkbox (owner
  // decision 2026-10-29 — the same instant-change pattern as Organizations' HQ/Public).
  const [offerNote, setOfferNote] = useState<{ key: string; error: string | null } | null>(null);

  // Only the latest load may land: every save reloads, and an earlier, slower reload landing
  // after a later one would put back the lists as they were.
  const latest = useRef(0);
  const reload = useCallback(() => {
    const seq = ++latest.current;
    apiFetch<StaffListsView>("/nod/api/list-categories").then(
      (v) => {
        if (seq !== latest.current) return;
        setView(v);
        setLoadError(null);
      },
      () => {
        if (seq !== latest.current) return;
        setLoadError("Couldn't load lists.");
      },
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

  const setOffered = async (noteKey: string, path: string, enabled: boolean) => {
    if (busy) return;
    setBusy(true);
    setSaveError(null);
    setMessage(null);
    setOfferNote(null);
    try {
      await apiFetch(path, { method: "PUT", body: { enabled } });
      setOfferNote({ key: noteKey, error: null });
    } catch (e) {
      setOfferNote({ key: noteKey, error: saveErrorText(e) });
    } finally {
      setBusy(false);
      reload();
    }
  };

  /** An Offer checkbox with its outcome beside it. The polite region is always rendered (empty
   * until a change), so the "Saved" that appears in it is announced. aria-disabled, not
   * disabled, while a change saves: a natively disabled checkbox drops keyboard focus. */
  const offerControl = (noteKey: string, label: string, checked: boolean, path: string) => {
    const note = offerNote?.key === noteKey ? offerNote : null;
    return (
      <>
        <span className="gcpe-inline-control">
          <label>
            <input
              type="checkbox"
              checked={checked}
              aria-disabled={busy || undefined}
              onChange={() => {
                if (!busy) void setOffered(noteKey, path, !checked);
              }}
            />{" "}
            {label}
          </label>
          <span aria-live="polite" className="gcpe-inline-note">
            {note && note.error === null ? "Saved" : ""}
          </span>
        </span>
        {note?.error && (
          <p role="alert" className="gcpe-inline-note gcpe-inline-note--error">
            Not saved: {note.error}
          </p>
        )}
      </>
    );
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
              {NAMES_SET_BY[c.namesFrom]}
              {!c.enabled && " Not offered to subscribers."}
            </p>
          ) : (
            <p>
              {/* Only Core administrators can open Media list names (shell/nav.ts). */}
              {isCoreAdmin(session) ? (
                <>
                  Media lists aren't changed here. Core administrators set these on <Link to="/media-list-names">Media list names</Link>.
                </>
              ) : (
                MEDIA_LISTS_TEXT
              )}
            </p>
          )}
          {canAdmin && (
            <div className="gcpe-subscribers__lists-controls">
              {c.editable && <div>{offerControl(`category:${c.key}`, `Offer ${c.name}`, c.enabled, `/nod/api/list-categories/${encodeURIComponent(c.key)}`)}</div>}
              <Button variant="secondary" isPending={busy} isDisabled={ci === 0} onPress={() => moveCategory(ci, -1)}>
                {`Move ${c.name} up`}
              </Button>
              <Button variant="secondary" isPending={busy} isDisabled={ci === view.categories.length - 1} onPress={() => moveCategory(ci, 1)}>
                {`Move ${c.name} down`}
              </Button>
            </div>
          )}
          {c.lists.length === 0 ? (
            <p>No lists yet.</p>
          ) : (
            <TableScroll label={`${c.name} lists`}>
            <table aria-label={`${c.name} lists`} className="gcpe-table">
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
                      {!l.active && " (retired)"}
                    </td>
                    <td>{l.subscribers}</td>
                    <td>
                      {offeredText(c, l)}
                      {canAdmin && c.editable && offerControl(`list:${l.listKey}`, `Offer ${l.name}`, l.enabled, `/nod/api/lists/${encodeURIComponent(l.listKey)}`)}
                    </td>
                    {canAdmin && c.editable && (
                      <td>
                        <Button variant="secondary" isPending={busy} isDisabled={li === 0} onPress={() => moveList(c, li, -1)}>
                          {`Move ${l.name} up`}
                        </Button>
                        <Button variant="secondary" isPending={busy} isDisabled={li === c.lists.length - 1} onPress={() => moveList(c, li, 1)}>
                          {`Move ${l.name} down`}
                        </Button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
            </TableScroll>
          )}
        </section>
      ))}
    </div>
  );
}

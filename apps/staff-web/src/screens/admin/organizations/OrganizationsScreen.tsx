import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Link } from "react-router";
import { InlineAlert } from "@bcgov/design-system-react-components";
import { apiFetch } from "../../../api/client";
import { useSession } from "../../../session/SessionContext";
import { useDocumentTitle } from "../../../shared/useDocumentTitle";
import { messagesOf } from "../messages";
import type { OrgRecord } from "@gcpe/events/catalogue";
import { AddOrganizationForm } from "./AddOrganizationForm";
import { OrganizationEditForm, SAVED_MESSAGE } from "./OrganizationEditForm";
import { HandOverPanel } from "./HandOverPanel";
import { abbreviationTakenMessage } from "./abbreviation";
import { canEditOrgProfile, isCoreAdmin } from "./access";

/**
 * `/hub/organizations`: Core.Admin and NRMS.SiteEditor see each organization's name and
 * minister and can open its public-facing profile for editing; only Core.Admin also sees and
 * sets the HQ and public switches (spec addendum §4, C124; Q54), each through its own
 * dedicated route. The HQ and Public columns are hidden, not disabled, for SiteEditors.
 * Inactive organizations are hidden until "Show inactive organizations" is ticked, and then
 * listed after every active one, so the list leads with the ministries staff actually edit.
 * Every role sees a "Not public" note beside a non-public organization's name (SiteEditors
 * have no Public column to tell them).
 *
 * An active row's Deactivate, and an inactive row's "Set successor…", open the hand-over panel
 * (new-government spec §4) above the table, like the edit form.
 */
export function OrganizationsScreen(): React.JSX.Element {
  const session = useSession();
  useDocumentTitle("Organizations");
  const isAdmin = isCoreAdmin(session);
  const canEdit = canEditOrgProfile(session);
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const editButtons = useRef(new Map<string, HTMLButtonElement>());
  const refocusKey = useRef<string | null>(null);
  // Where focus goes after a row action re-renders the row (hand-over panel/Reactivate).
  // "toggle": the row left the list (deactivated while inactive ones are hidden).
  const rowFocus = useRef<{
    key: string;
    target: "edit" | "handOver" | "toggle";
  } | null>(null);
  const [showInactive, setShowInactive] = useState(false);
  const toggle = useRef<HTMLInputElement>(null);
  const toggleId = useId();
  // Each row's Deactivate (active) or Set successor… (inactive) button: the panel's opener.
  const handOverButtons = useRef(new Map<string, HTMLButtonElement>());
  const [rowError, setRowError] = useState<{
    key: string;
    messages: string[];
  } | null>(null);
  const [orgs, setOrgs] = useState<OrgRecord[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [messages, setMessages] = useState<string[]>([]);
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // The hand-over panel's save in flight: every other row action waits for it.
  const [panelBusy, setPanelBusy] = useState(false);
  const [adding, setAdding] = useState(false);
  const [handOverKey, setHandOverKey] = useState<string | null>(null);
  const addButton = useRef<HTMLButtonElement>(null);
  const latest = useRef(0);

  const reload = useCallback(() => {
    const call = ++latest.current;
    apiFetch<OrgRecord[]>("/core/api/organizations").then(
      (o) => {
        if (call === latest.current) setOrgs(o);
      },
      () => {
        if (call === latest.current)
          setLoadError("Couldn't load organizations.");
      },
    );
  }, []);

  useEffect(() => {
    if (canEdit) reload();
  }, [canEdit, reload]);

  // After the form closes (save or cancel), focus returns to that row's Edit button.
  useEffect(() => {
    if (editingKey === null && refocusKey.current) {
      editButtons.current.get(refocusKey.current)?.focus();
      refocusKey.current = null;
    }
  }, [editingKey, orgs]);

  useEffect(() => {
    const f = rowFocus.current;
    if (!f) return;
    const el =
      f.target === "edit"
        ? editButtons.current.get(f.key)
        : f.target === "handOver"
          ? handOverButtons.current.get(f.key)
          : toggle.current;
    if (el) {
      el.focus();
      rowFocus.current = null;
    }
  }, [handOverKey, orgs]);

  if (!canEdit) {
    return (
      <div className="gcpe-organizations">
        <h1>Organizations</h1>
        <p>You don&rsquo;t have permission to view this page.</p>
      </div>
    );
  }

  const setFlag = async (
    o: OrgRecord,
    flag: "hq" | "public",
    value: boolean,
  ) => {
    setBusy(true);
    setMessages([]);
    setStatus(null);
    try {
      await apiFetch(
        `/core/api/organizations/${encodeURIComponent(o.key)}/${flag}`,
        {
          method: "PUT",
          body: flag === "hq" ? { isHq: value } : { isPublic: value },
        },
      );
      setStatus(
        flag === "hq"
          ? `${o.displayName} is ${value ? "now" : "no longer"} an HQ organization.`
          : `${o.displayName} is ${value ? "now" : "no longer"} listed publicly.`,
      );
      reload();
    } catch (caught) {
      setMessages(messagesOf(caught));
    } finally {
      setBusy(false);
    }
  };

  // An open edit form was built from the row's old state; saving it after a row action would undo that action.
  const closeFormFor = (key: string) =>
    setEditingKey((k) => (k === key ? null : k));

  // After the hand-over panel saves: a plain deactivation (no successor) or a succession.
  const handedOver = (o: OrgRecord, successorName: string | null) => {
    // An already-inactive row (Set successor…) is on screen only while inactive ones are shown.
    rowFocus.current = {
      key: o.key,
      target: showInactive || !o.isActive ? "edit" : "toggle",
    };
    closeFormFor(o.key);
    setHandOverKey(null);
    setMessages([]);
    setRowError(null);
    const done = successorName
      ? `${o.displayName} is deactivated. Its pages now send visitors to ${successorName}. Moves to other services finish shortly.`
      : `${o.displayName} is deactivated.`;
    setStatus(
      showInactive || !o.isActive
        ? done
        : `${done} Inactive organizations are hidden: tick Show inactive organizations to see it.`,
    );
    reload();
  };

  const reactivate = async (o: OrgRecord) => {
    if (busy) return;
    setBusy(true);
    setMessages([]);
    setRowError(null);
    setStatus(null);
    try {
      const updated = await apiFetch<OrgRecord>(
        `/core/api/organizations/${encodeURIComponent(o.key)}/profile`,
        { method: "PATCH", body: { isActive: true } },
      );
      rowFocus.current = { key: o.key, target: "edit" };
      closeFormFor(o.key);
      // Reactivating never changes the Public flag, so a ministry made non-public stays hidden.
      setStatus(
        updated.isPublic
          ? `${o.displayName} is active again.`
          : `${o.displayName} is active again. It isn't public: tick Public to list it on the public site.`,
      );
      reload();
    } catch (caught) {
      // Core's 409: another active ministry (usually its successor) now holds its abbreviation.
      const taken = abbreviationTakenMessage(caught) !== null;
      const body = taken ? (caught as { body?: { takenBy?: string } }).body : undefined;
      setRowError({
        key: o.key,
        messages: taken
          ? [
              `${o.displayName} can't be reactivated while ${body?.takenBy ?? "another ministry"} uses its abbreviation${o.abbreviation ? ` ${o.abbreviation}` : ""}. Give one of them a different abbreviation first.`,
            ]
          : messagesOf(caught),
      });
    } finally {
      setBusy(false);
    }
  };

  const inactiveCount = orgs?.filter((o) => !o.isActive).length ?? 0;
  // Active first, in the server's order; inactive after them, and only when asked for.
  const rows = orgs
    ? [
        ...orgs.filter((o) => o.isActive),
        ...(showInactive ? orgs.filter((o) => !o.isActive) : []),
      ]
    : [];

  return (
    <div className="gcpe-organizations">
      <h1>Organizations</h1>
      <p>
        Ministry and minister names here appear on the public Ministries page.
      </p>
      {isAdmin && (
        <>
          <p>
            Members of an HQ organization see every ministry in the Corporate
            Calendar and get its HQ-only fields and actions.
          </p>
          <p>
            Organizations that aren&rsquo;t public are left out of the public
            ministry list and the subscribe page.
          </p>
          <p>
            New cabinet?{" "}
            <Link to="/organizations/cabinet-change">Cabinet change</Link> lets
            you prepare renames, new ministries and hand-overs together, then
            publish them all at once or at the swearing-in time.
          </p>
        </>
      )}
      {loadError && (
        <InlineAlert variant="danger" role="alert" description={loadError} />
      )}
      {messages.map((m) => (
        <p role="alert" key={m}>
          {m}
        </p>
      ))}
      {status && <p role="status">{status}</p>}
      {orgs === null && !loadError && <p>Loading…</p>}
      {isAdmin && orgs && !adding && (
        <p>
          <button
            type="button"
            ref={addButton}
            disabled={panelBusy}
            onClick={() => {
              setStatus(null);
              setEditingKey(null);
              setAdding(true);
            }}
          >
            Add ministry
          </button>
        </p>
      )}
      {isAdmin && adding && (
        <AddOrganizationForm
          orgs={orgs ?? []}
          onCancel={() => {
            setAdding(false);
            setTimeout(() => addButton.current?.focus(), 0);
          }}
          onCreated={(key) => {
            setAdding(false);
            setMessages([]);
            setStatus(null);
            reload();
            setEditingKey(key);
          }}
        />
      )}
      {orgs && editingKey && orgs.some((o) => o.key === editingKey) && (
        <OrganizationEditForm
          key={editingKey}
          org={orgs.find((o) => o.key === editingKey)!}
          orgs={orgs}
          isAdmin={isAdmin}
          onCancel={() => {
            refocusKey.current = editingKey;
            setEditingKey(null);
          }}
          onSaved={(saved) => {
            // Saved as inactive while inactive ones are hidden, the row leaves the list.
            if (!saved.isActive && !showInactive)
              rowFocus.current = { key: saved.key, target: "toggle" };
            else refocusKey.current = editingKey;
            setEditingKey(null);
            setMessages([]);
            setStatus(SAVED_MESSAGE);
            reload();
          }}
        />
      )}
      {isAdmin &&
        orgs &&
        handOverKey &&
        orgs.some((o) => o.key === handOverKey) && (
          <HandOverPanel
            key={`hand-over-${handOverKey}`}
            org={orgs.find((o) => o.key === handOverKey)!}
            orgs={orgs}
            onBusyChange={setPanelBusy}
            onCancel={() => {
              rowFocus.current = { key: handOverKey, target: "handOver" };
              setHandOverKey(null);
            }}
            onDone={(successorName) =>
              handedOver(
                orgs.find((o) => o.key === handOverKey)!,
                successorName,
              )
            }
          />
        )}
      {orgs && (inactiveCount > 0 || showInactive) && (
        <p>
          <input
            id={toggleId}
            ref={toggle}
            type="checkbox"
            checked={showInactive}
            onChange={(e) => setShowInactive(e.target.checked)}
          />{" "}
          <label htmlFor={toggleId}>
            Show inactive organizations ({inactiveCount})
          </label>
        </p>
      )}
      {orgs && (
        <table className="gcpe-table">
          <caption>Organizations and their ministers</caption>
          <thead>
            <tr>
              <th scope="col">Name</th>
              <th scope="col">Abbreviation</th>
              <th scope="col">Minister</th>
              <th scope="col">Active</th>
              {isAdmin && <th scope="col">HQ</th>}
              {isAdmin && <th scope="col">Public</th>}
              <th scope="col">Actions</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((o) => (
              <tr key={o.key}>
                <td>
                  {o.displayName}
                  {!o.isPublic && (
                    <>
                      {" "}
                      <span className="gcpe-badge">Not public</span>
                    </>
                  )}
                </td>
                <td>{o.abbreviation ?? ""}</td>
                <td>{o.minister.name ?? ""}</td>
                <td>{o.isActive ? "Yes" : "No"}</td>
                {isAdmin && (
                  <td>
                    <input
                      type="checkbox"
                      aria-label={`${o.displayName} is an HQ organization`}
                      checked={o.isHq}
                      disabled={busy || panelBusy}
                      onChange={(e) => void setFlag(o, "hq", e.target.checked)}
                    />
                  </td>
                )}
                {isAdmin && (
                  <td>
                    <input
                      type="checkbox"
                      aria-label={`${o.displayName} is listed publicly`}
                      checked={o.isPublic}
                      disabled={busy || panelBusy}
                      onChange={(e) =>
                        void setFlag(o, "public", e.target.checked)
                      }
                    />
                  </td>
                )}
                <td>
                  <button
                    type="button"
                    ref={(el) => {
                      if (el) editButtons.current.set(o.key, el);
                      else editButtons.current.delete(o.key);
                    }}
                    aria-label={`Edit ${o.displayName}`}
                    disabled={panelBusy}
                    onClick={() => {
                      setStatus(null);
                      setEditingKey(o.key);
                    }}
                  >
                    Edit
                  </button>
                  {isAdmin && (
                    <>
                      {" "}
                      <button
                        type="button"
                        ref={(el) => {
                          if (el) handOverButtons.current.set(o.key, el);
                          else handOverButtons.current.delete(o.key);
                        }}
                        aria-label={
                          o.isActive
                            ? `Deactivate ${o.displayName}`
                            : `Set successor for ${o.displayName}`
                        }
                        aria-expanded={handOverKey === o.key}
                        disabled={busy || panelBusy}
                        onClick={() => {
                          setStatus(null);
                          setRowError(null);
                          setHandOverKey(o.key);
                        }}
                      >
                        {o.isActive ? "Deactivate" : "Set successor…"}
                      </button>
                    </>
                  )}
                  {isAdmin && !o.isActive && (
                    <>
                      {" "}
                      <button
                        type="button"
                        aria-label={`Reactivate ${o.displayName}`}
                        disabled={panelBusy}
                        onClick={() => void reactivate(o)}
                      >
                        Reactivate
                      </button>
                    </>
                  )}
                  {rowError?.key === o.key &&
                    rowError.messages.map((m) => (
                      <p role="alert" key={m}>
                        {m}
                      </p>
                    ))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

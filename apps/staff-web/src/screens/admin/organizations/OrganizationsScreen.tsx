import { useCallback, useEffect, useRef, useState } from "react";
import { InlineAlert } from "@bcgov/design-system-react-components";
import { apiFetch } from "../../../api/client";
import { useSession } from "../../../session/SessionContext";
import { useDocumentTitle } from "../../../shared/useDocumentTitle";
import { messagesOf } from "../messages";
import type { OrgRecord } from "@gcpe/events/catalogue";
import { canEditOrgProfile, isCoreAdmin } from "./access";

/**
 * `/hub/organizations`: Core.Admin and NRMS.SiteEditor see each organization's name and
 * minister and can open its public-facing profile for editing; only Core.Admin also sees and
 * sets the HQ and public switches (spec addendum §4, C124; Q54), each through its own
 * dedicated route. The HQ and Public columns are hidden, not disabled, for SiteEditors.
 */
export function OrganizationsScreen(): React.JSX.Element {
  const session = useSession();
  useDocumentTitle("Organizations");
  const isAdmin = isCoreAdmin(session);
  const canEdit = canEditOrgProfile(session);
  // Task 5 renders the edit form for this key.
  const [, setEditingKey] = useState<string | null>(null);
  const [orgs, setOrgs] = useState<OrgRecord[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [messages, setMessages] = useState<string[]>([]);
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const latest = useRef(0);

  const reload = useCallback(() => {
    const call = ++latest.current;
    apiFetch<OrgRecord[]>("/core/api/organizations").then(
      (o) => {
        if (call === latest.current) setOrgs(o);
      },
      () => {
        if (call === latest.current) setLoadError("Couldn't load organizations.");
      },
    );
  }, []);

  useEffect(() => {
    if (canEdit) reload();
  }, [canEdit, reload]);

  if (!canEdit) {
    return (
      <div className="gcpe-organizations">
        <h1>Organizations</h1>
        <p>You don&rsquo;t have permission to view this page.</p>
      </div>
    );
  }

  const setFlag = async (o: OrgRecord, flag: "hq" | "public", value: boolean) => {
    setBusy(true);
    setMessages([]);
    setStatus(null);
    try {
      await apiFetch(`/core/api/organizations/${encodeURIComponent(o.key)}/${flag}`, { method: "PUT", body: flag === "hq" ? { isHq: value } : { isPublic: value } });
      setStatus(flag === "hq" ? `${o.displayName} is ${value ? "now" : "no longer"} an HQ organization.` : `${o.displayName} is ${value ? "now" : "no longer"} listed publicly.`);
      reload();
    } catch (caught) {
      setMessages(messagesOf(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="gcpe-organizations">
      <h1>Organizations</h1>
      <p>Ministry and minister names here appear on the public Ministries page.</p>
      {isAdmin && (
        <>
          <p>Members of an HQ organization see every ministry in the Corporate Calendar and get its HQ-only fields and actions.</p>
          <p>Organizations that aren&rsquo;t public are left out of the public ministry list and the subscribe page.</p>
        </>
      )}
      {loadError && <InlineAlert variant="danger" role="alert" description={loadError} />}
      {messages.map((m) => (
        <p role="alert" key={m}>
          {m}
        </p>
      ))}
      {status && <p role="status">{status}</p>}
      {orgs === null && !loadError && <p>Loading…</p>}
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
            {orgs.map((o) => (
              <tr key={o.key}>
                <td>{o.displayName}</td>
                <td>{o.abbreviation ?? ""}</td>
                <td>{o.minister.name ?? ""}</td>
                <td>{o.isActive ? "Yes" : "No"}</td>
                {isAdmin && (
                  <td>
                    <input type="checkbox" aria-label={`${o.displayName} is an HQ organization`} checked={o.isHq} disabled={busy} onChange={(e) => void setFlag(o, "hq", e.target.checked)} />
                  </td>
                )}
                {isAdmin && (
                  <td>
                    <input
                      type="checkbox"
                      aria-label={`${o.displayName} is listed publicly`}
                      checked={o.isPublic}
                      disabled={busy}
                      onChange={(e) => void setFlag(o, "public", e.target.checked)}
                    />
                  </td>
                )}
                <td>
                  <button type="button" aria-label={`Edit ${o.displayName}`} onClick={() => setEditingKey(o.key)}>
                    Edit
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

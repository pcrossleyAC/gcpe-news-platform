import { useCallback, useEffect, useRef, useState } from "react";
import { InlineAlert } from "@bcgov/design-system-react-components";
import { apiFetch } from "../../../api/client";
import { useSession } from "../../../session/SessionContext";
import { useDocumentTitle } from "../../../shared/useDocumentTitle";
import { messagesOf } from "../messages";
import type { OrgOption } from "../calendar-access/CalendarAccessScreen";

/**
 * `/hub/organizations`: Core.Admin's HQ and public switches (spec addendum §4, C124; Q54).
 * Organizations themselves are edited by the seed and the importer; this screen only sets
 * `isHq` and `isPublic`, each through its own dedicated route.
 */
export function OrganizationsScreen(): React.JSX.Element {
  const session = useSession();
  useDocumentTitle("Organizations");
  const isAdmin = session.has("Core.Admin");
  const [orgs, setOrgs] = useState<OrgOption[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [messages, setMessages] = useState<string[]>([]);
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const latest = useRef(0);

  const reload = useCallback(() => {
    const call = ++latest.current;
    apiFetch<OrgOption[]>("/core/api/organizations").then(
      (o) => {
        if (call === latest.current) setOrgs(o);
      },
      () => {
        if (call === latest.current) setLoadError("Couldn't load organizations.");
      },
    );
  }, []);

  useEffect(() => {
    if (isAdmin) reload();
  }, [isAdmin, reload]);

  if (!isAdmin) {
    return (
      <div className="gcpe-organizations">
        <h1>Organizations</h1>
        <p>You don&rsquo;t have permission to view this page.</p>
      </div>
    );
  }

  const setFlag = async (o: OrgOption, flag: "hq" | "public", value: boolean) => {
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
      <p>Members of an HQ organization see every ministry in the Corporate Calendar and get its HQ-only fields and actions.</p>
      <p>Organizations that aren&rsquo;t public are left out of the public ministry list and the subscribe page.</p>
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
          <caption>Organizations, their HQ flag and whether they&rsquo;re public</caption>
          <thead>
            <tr>
              <th scope="col">Name</th>
              <th scope="col">Abbreviation</th>
              <th scope="col">Active</th>
              <th scope="col">HQ</th>
              <th scope="col">Public</th>
            </tr>
          </thead>
          <tbody>
            {orgs.map((o) => (
              <tr key={o.key}>
                <td>{o.displayName}</td>
                <td>{o.abbreviation ?? ""}</td>
                <td>{o.isActive ? "Yes" : "No"}</td>
                <td>
                  <input type="checkbox" aria-label={`${o.displayName} is an HQ organization`} checked={o.isHq} disabled={busy} onChange={(e) => void setFlag(o, "hq", e.target.checked)} />
                </td>
                <td>
                  <input
                    type="checkbox"
                    aria-label={`${o.displayName} is listed publicly`}
                    checked={o.isPublic}
                    disabled={busy}
                    onChange={(e) => void setFlag(o, "public", e.target.checked)}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

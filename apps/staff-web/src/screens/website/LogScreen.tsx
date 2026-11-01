import { useCallback, useEffect, useState } from "react";
import { InlineAlert } from "@bcgov/design-system-react-components";
import { apiFetch } from "../../api/client";
import { useTenantTimeZone } from "../../format/tenantTimeZone";
import { formatWhen } from "../../format/dates";
import { TableScroll } from "../../shared/TableScroll";
import { useDocumentTitle } from "../../shared/useDocumentTitle";
import { SITE_LOG_AREAS, type SiteLogArea, type SiteLogEntry } from "./types";
import { useOptionalSession } from "../../session/SessionContext";

const AREA_LABEL: Record<SiteLogArea, string> = {
  carousel: "Carousel",
  pins: "Emergency pins",
  "live-feed": "Live Feed",
  "blue-bridge": "Project Blue Bridge",
  links: "Resource links",
  files: "Files",
  features: "Features",
  settings: "Site settings",
  // Suite review O3: Core administrators' Government terms changes (NRMS keeps them in this log).
  "government-terms": "Government terms",
};

/**
 * `/hub/website/log` (task-5-brief.md): `GET /site/log?area=&limit=`, newest first (the server
 * already orders it that way — see apps/nrms/src/http/site-routes.ts's `orderBy(desc(at), ...)`).
 * Read-only for every role that can reach the Website section.
 */
export function LogScreen(): React.JSX.Element {
  const timeZone = useTenantTimeZone();
  useDocumentTitle("Website log");
  const [area, setArea] = useState<SiteLogArea | "">("");
  // Core administrators alone see Government terms lines (the server leaves them out for everyone else).
  const isCoreAdmin = useOptionalSession()?.has("Core.Admin") ?? false;
  const areas = SITE_LOG_AREAS.filter((a) => a !== "government-terms" || isCoreAdmin);
  const [entries, setEntries] = useState<SiteLogEntry[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const reload = useCallback((a: SiteLogArea | "") => {
    const qs = a ? `?area=${a}&limit=200` : "?limit=200";
    apiFetch<SiteLogEntry[]>(`/nrms/api/site/log${qs}`).then(setEntries, () => setLoadError("Couldn't load the website log."));
  }, []);

  useEffect(() => reload(area), [reload, area]);

  if (loadError) {
    return (
      <div className="gcpe-website-log">
        <h1>Website log</h1>
        <InlineAlert variant="danger" role="alert" description={loadError} />
      </div>
    );
  }

  return (
    <div className="gcpe-website-log">
      <h1>Website log</h1>

      <label>
        Filter by area
        <select value={area} onChange={(e) => setArea(e.target.value as SiteLogArea | "")}>
          <option value="">(all)</option>
          {areas.map((a) => (
            <option key={a} value={a}>
              {AREA_LABEL[a]}
            </option>
          ))}
        </select>
      </label>

      {entries === null ? (
        <p>Loading…</p>
      ) : entries.length === 0 ? (
        <p>No log entries yet.</p>
      ) : (
        <TableScroll label="Website log">
        <table className="gcpe-table">
          <caption>Website log</caption>
          <thead>
            <tr>
              <th scope="col">When</th>
              <th scope="col">Who</th>
              <th scope="col">Area</th>
              <th scope="col">What</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((e, i) => (
              <tr key={i}>
                <td>{formatWhen(e.at, new Date(), timeZone)}</td>
                <td>{e.actorName}</td>
                <td>{AREA_LABEL[e.area]}</td>
                <td>{e.text}</td>
              </tr>
            ))}
          </tbody>
        </table>
        </TableScroll>
      )}
    </div>
  );
}

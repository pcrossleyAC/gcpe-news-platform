import { useCallback, useEffect, useState } from "react";
import { InlineAlert } from "@bcgov/design-system-react-components";
import { apiFetch } from "../../api/client";
import { useTenantTimeZone } from "../../format/tenantTimeZone";
import { formatWhen } from "../../format/dates";
import { useDocumentTitle } from "../../shared/useDocumentTitle";
import { SITE_LOG_AREAS, type SiteLogArea, type SiteLogEntry } from "./types";

const AREA_LABEL: Record<SiteLogArea, string> = {
  carousel: "Carousel",
  pins: "Emergency pins",
  "live-feed": "Live Feed",
  "blue-bridge": "Project Blue Bridge",
  links: "Resource links",
  files: "Files",
  features: "Features",
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
          {SITE_LOG_AREAS.map((a) => (
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
        <table>
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
      )}
    </div>
  );
}

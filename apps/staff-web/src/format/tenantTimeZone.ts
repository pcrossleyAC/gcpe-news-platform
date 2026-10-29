import { useEffect, useState } from "react";
import { apiFetch } from "../api/client";
import { useOptionalSession } from "../session/SessionContext";

/** The BC tenant's own zone (packages/config/src/tenant.ts) — used only until `GET
 * /nrms/api/config` resolves, or if it fails, so {@link relativeDay}/{@link formatWhen} always
 * have a real IANA zone to format against instead of an empty string. */
const FALLBACK_TIME_ZONE = "America/Vancouver";

interface ConfigResponse {
  timeZone: string;
}

/** The roles `GET /nrms/api/config` accepts (apps/nrms/src/http/routes.ts's `anySignedIn`). */
const NRMS_CONFIG_ROLES = ["NRMS.Viewer", "NRMS.Editor", "NRMS.SiteEditor", "Core.Admin"];

/**
 * Where the zone comes from: `/nrms/api/config` for anyone it accepts (unchanged), and for staff
 * with none of those roles (Subscribers-only, Calendar-only) `GET /core/api/time-zone-check`,
 * which any signed-in user may read and which gives the same tenant zone — so their screens
 * no longer ask NRMS for it and get a 403 on every visit.
 */
function timeZoneSource(session: ReturnType<typeof useOptionalSession>): string {
  if (!session?.user || NRMS_CONFIG_ROLES.some((r) => session.has(r))) return "/nrms/api/config";
  return "/core/api/time-zone-check";
}

/** Fetches `GET /nrms/api/config` (Task 1) once per mount and returns its `timeZone` — the
 * zone every staff screen must format dates in (constraints.md). */
export function useTenantTimeZone(): string {
  return useTenantTimeZoneStatus().timeZone;
}

/**
 * {@link useTenantTimeZone} plus whether the zone is settled: `resolved` is false until
 * `/nrms/api/config` has answered (or failed, leaving the fallback). A screen that converts
 * stored instants to wall-clock for editing must wait for it — converting with the fallback and
 * sending the result back would shift the times on a tenant in another zone.
 */
export function useTenantTimeZoneStatus(): { timeZone: string; resolved: boolean } {
  const [status, setStatus] = useState({ timeZone: FALLBACK_TIME_ZONE, resolved: false });
  const source = timeZoneSource(useOptionalSession());

  useEffect(() => {
    let active = true;
    apiFetch<ConfigResponse>(source).then(
      (config) => {
        if (active) setStatus({ timeZone: config.timeZone, resolved: true });
      },
      () => {
        // Keep the fallback — a screen with a slightly-wrong-if-ever-different zone beats one
        // that can't format dates at all.
        if (active) setStatus((s) => ({ ...s, resolved: true }));
      },
    );
    return () => {
      active = false;
    };
  }, [source]);

  return status;
}

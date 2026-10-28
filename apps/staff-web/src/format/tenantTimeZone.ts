import { useEffect, useState } from "react";
import { apiFetch } from "../api/client";

/** The BC tenant's own zone (packages/config/src/tenant.ts) — used only until `GET
 * /nrms/api/config` resolves, or if it fails, so {@link relativeDay}/{@link formatWhen} always
 * have a real IANA zone to format against instead of an empty string. */
const FALLBACK_TIME_ZONE = "America/Vancouver";

interface ConfigResponse {
  timeZone: string;
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

  useEffect(() => {
    let active = true;
    apiFetch<ConfigResponse>("/nrms/api/config").then(
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
  }, []);

  return status;
}

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
  const [timeZone, setTimeZone] = useState(FALLBACK_TIME_ZONE);

  useEffect(() => {
    let active = true;
    apiFetch<ConfigResponse>("/nrms/api/config").then(
      (config) => {
        if (active) setTimeZone(config.timeZone);
      },
      () => {
        // Keep the fallback — a screen with a slightly-wrong-if-ever-different zone beats one
        // that can't format dates at all.
      },
    );
    return () => {
      active = false;
    };
  }, []);

  return timeZone;
}

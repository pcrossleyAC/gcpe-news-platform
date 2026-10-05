import { useEffect, useState } from "react";
import { apiFetch } from "../api/client";

interface TzCheck {
  at: string;
  offsetMinutes: number;
}
interface ConfigResponse {
  tzCheck?: TzCheck;
}

/**
 * Fix round 1 (3f Task 3), finding 3: `GET /nrms/api/config`'s `tzCheck` gives a (instant,
 * server's UTC offset) pair; this compares it against the *browser's own* offset for that same
 * instant (`Date.prototype.getTimezoneOffset`, which reflects the browser/OS's own tzdata,
 * regardless of which IANA zone it thinks it's in). A stale browser — one that doesn't yet know
 * about BC's permanent UTC-7 switch (2026-11-01) — disagrees, and {@link AppShell} shows a
 * persistent warning so a staff member doesn't unknowingly schedule or read a time an hour off.
 *
 * Fails safe: a missing `tzCheck` or a failed fetch never shows a warning — the absence of a
 * signal is not evidence of staleness.
 */
export function useTimeZoneWarning(): boolean {
  const [mismatch, setMismatch] = useState(false);

  useEffect(() => {
    apiFetch<ConfigResponse>("/nrms/api/config").then(
      (config) => {
        if (!config.tzCheck) return;
        // getTimezoneOffset() is UTC-minus-local (e.g. +420 for UTC-7); flip the sign to match
        // tzCheck.offsetMinutes's convention (negative west of UTC, e.g. -420 for UTC-7).
        const browserOffsetMinutes = -new Date(config.tzCheck.at).getTimezoneOffset();
        if (browserOffsetMinutes !== config.tzCheck.offsetMinutes) setMismatch(true);
      },
      () => {
        // No warning if the check itself couldn't be made.
      },
    );
  }, []);

  return mismatch;
}

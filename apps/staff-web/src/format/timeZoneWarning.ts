import { useEffect, useState } from "react";
import { apiFetch } from "../api/client";

interface TzCheck {
  at: string;
  offsetMinutes: number;
}
interface ConfigResponse {
  /** The tenant zone (e.g. "America/Vancouver") — fix round 2: the browser's answer is asked
   * *for this zone specifically*, never for whatever zone the device itself happens to be set
   * to (see {@link browserOffsetMinutesFor}). */
  timeZone?: string;
  tzCheck?: TzCheck;
}

/**
 * The browser's own answer for `timeZone`'s UTC offset at the instant `at`, in minutes —
 * negative west of UTC (e.g. -420 for UTC-7), the same sign convention `GET /config`'s
 * `tzCheck.offsetMinutes` uses (see `packages/config/src/timezone.ts`'s `utcOffsetMinutes`,
 * which computes the *server's* side of this same comparison the same way). Uses
 * `Intl.DateTimeFormat` with an explicit `timeZone`, never `Date.prototype.getTimezoneOffset()`
 * (fix round 2, bug 2: that reflects the *device's* own zone, not the tenant's — a BC staff
 * member on a laptop set to any other zone got a false "update your browser" banner even with
 * perfectly current tzdata, because their device's offset was being compared against
 * Vancouver's expected offset instead of being asked what the device's own tzdata says
 * Vancouver's offset actually is).
 *
 * Returns `null` if the browser's `Intl` answer can't be parsed (fails safe: no warning rather
 * than a wrong one).
 */
function browserOffsetMinutesFor(at: string, timeZone: string): number | null {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "longOffset" }).formatToParts(new Date(at));
  const raw = parts.find((p) => p.type === "timeZoneName")?.value ?? "GMT";
  if (raw === "GMT") return 0;
  const m = /^GMT([+-])(\d{2}):(\d{2})$/.exec(raw);
  if (!m) return null;
  const sign = m[1] === "-" ? -1 : 1;
  return sign * (Number(m[2]) * 60 + Number(m[3]));
}

/**
 * Fix round 1 (3f Task 3), finding 3: `GET /nrms/api/config`'s `tzCheck` gives a (instant,
 * server's UTC offset) pair for the tenant zone (`config.timeZone`); this asks the *browser's
 * own* `Intl`/tzdata what offset it computes for that same zone at that same instant
 * ({@link browserOffsetMinutesFor}) and compares. A stale browser — one that doesn't yet know
 * about BC's permanent UTC-7 switch (2026-11-01) — disagrees for `America/Vancouver`
 * specifically, regardless of what zone the device itself is set to, and {@link AppShell} shows
 * a persistent warning so a staff member doesn't unknowingly schedule or read a time an hour off.
 *
 * Fails safe: a missing `tzCheck`/`timeZone`, an unparseable browser answer, or a failed fetch
 * never shows a warning — the absence of a clear signal is not evidence of staleness.
 */
export function useTimeZoneWarning(): boolean {
  const [mismatch, setMismatch] = useState(false);

  useEffect(() => {
    apiFetch<ConfigResponse>("/nrms/api/config").then(
      (config) => {
        if (!config.tzCheck || !config.timeZone) return;
        const browserOffsetMinutes = browserOffsetMinutesFor(config.tzCheck.at, config.timeZone);
        if (browserOffsetMinutes !== null && browserOffsetMinutes !== config.tzCheck.offsetMinutes) setMismatch(true);
      },
      () => {
        // No warning if the check itself couldn't be made.
      },
    );
  }, []);

  return mismatch;
}

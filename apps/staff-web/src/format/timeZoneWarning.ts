import { useEffect, useState } from "react";
import { apiFetch } from "../api/client";
import { browserOffsetMinutes, setServerZoneRule } from "./bcTime";

interface TzCheck {
  at: string;
  offsetMinutes: number;
  /** Since when the zone has kept `offsetMinutes` for good (packages/config `offsetFixedSince`); null if it still changes. */
  fixedSince?: string | null;
}
interface ConfigResponse {
  /** The tenant zone (e.g. "America/Vancouver") — the browser's answer is asked *for this zone
   * specifically*, never for whatever zone the device itself happens to be set to. */
  timeZone?: string;
  tzCheck?: TzCheck;
}

/** How long the Hub holds a screen back waiting for the check before showing it anyway. */
export const TIME_ZONE_CHECK_WAIT_MS = 3000;

export interface TimeZoneCheck {
  /** The check has answered (or failed, or taken longer than {@link TIME_ZONE_CHECK_WAIT_MS}). */
  settled: boolean;
  /** `corrected`: the browser's tzdata is out of date and the Hub is showing times by the
   * server's rules. `stale`: out of date, and the server gave nothing to correct it with. */
  warning: "corrected" | "stale" | null;
  /** Goes up when a correction arrives after the screen was already shown, so AppShell redraws it. */
  generation: number;
}

/**
 * `GET /core/api/time-zone-check` (open to any signed-in user, so Calendar-only and NoD-only
 * staff are covered too) gives the tenant zone, the server's UTC offset for it at a pinned
 * instant, and since when that offset has been fixed. This asks the *browser's own* `Intl` for
 * that zone's offset at that instant. A browser whose tzdata predates BC's permanent UTC-7
 * (2026-11-01) disagrees; then, owner decision 2026-10-31, the Hub shows times by the server's
 * rules ({@link setServerZoneRule}, format/bcTime.ts) and AppShell says so in a persistent notice.
 *
 * AppShell waits for this before showing the screen, so the first times anyone sees are already
 * right. Fails safe: a missing `tzCheck`/`timeZone`, an unreadable browser answer, or a failed
 * fetch changes nothing — the absence of a clear signal is not evidence of staleness.
 */
export function useTimeZoneWarning(): TimeZoneCheck {
  const [state, setState] = useState<TimeZoneCheck>({ settled: false, warning: null, generation: 0 });

  useEffect(() => {
    let active = true;
    const settle = () => {
      if (active) setState((s) => (s.settled ? s : { ...s, settled: true }));
    };
    const timer = setTimeout(settle, TIME_ZONE_CHECK_WAIT_MS);
    apiFetch<ConfigResponse>("/core/api/time-zone-check")
      .then(
        (config) => {
          if (!active || !config.tzCheck || !config.timeZone) return;
          const { at, offsetMinutes, fixedSince } = config.tzCheck;
          const browser = browserOffsetMinutes(Date.parse(at), config.timeZone);
          if (browser === null || browser === offsetMinutes) return;
          const fixedSinceMs = fixedSince ? Date.parse(fixedSince) : NaN;
          if (Number.isNaN(fixedSinceMs)) {
            setState((s) => ({ ...s, settled: true, warning: "stale" }));
            return;
          }
          setServerZoneRule({ timeZone: config.timeZone, fixedSinceMs, offsetMinutes });
          setState((s) => ({ settled: true, warning: "corrected", generation: s.settled ? s.generation + 1 : s.generation }));
        },
        () => {
          // No warning if the check itself couldn't be made.
        },
      )
      .finally(() => {
        clearTimeout(timer);
        settle();
      });
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, []);

  return state;
}

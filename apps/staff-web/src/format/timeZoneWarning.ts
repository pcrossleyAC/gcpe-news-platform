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

/**
 * The Hub's own zone and a post-2026-11-01 instant with its true offset, used only *before or
 * without* the server's answer: a browser that already says UTC-7 there needn't wait for the
 * check (review minor 1), and one that doesn't, when the check fails, gets the warning (minor
 * 3). The correction itself always comes from the server's tzCheck, never from these.
 */
const HUB_ZONE = "America/Vancouver";
const AFTER_CHANGE = "2026-12-15T20:00:00Z";
const AFTER_CHANGE_OFFSET = -420;
const browserAgreesForBc = (): boolean | null => {
  const b = browserOffsetMinutes(Date.parse(AFTER_CHANGE), HUB_ZONE);
  return b === null ? null : b === AFTER_CHANGE_OFFSET;
};

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
 * right (only a browser whose own BC answer is wrong waits). Fails safe: a missing
 * `tzCheck`/`timeZone` or an unreadable browser answer changes nothing; a failed fetch shows the
 * warning only when the browser's own answer for BC after 2026-11-01 is plainly not UTC-7.
 */
export function useTimeZoneWarning(): TimeZoneCheck {
  // A browser whose own BC answer is already right shows the screen at once; the check still
  // runs (a tenant in another zone, or the server disagreeing, can still correct and redraw).
  const [state, setState] = useState<TimeZoneCheck>(() => ({ settled: browserAgreesForBc() === true, warning: null, generation: 0 }));

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
          // The check couldn't be made: nothing to correct with, but a browser that is plainly
          // wrong for BC after 2026-11-01 is still told so.
          if (active && browserAgreesForBc() === false) setState((s) => ({ ...s, settled: true, warning: "stale" }));
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

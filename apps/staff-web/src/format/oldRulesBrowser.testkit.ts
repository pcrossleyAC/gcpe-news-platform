import { vi } from "vitest";
import { clearBcTimeCachesForTests, setServerZoneRule } from "./bcTime";

/** What GET /core/api/time-zone-check says for BC (packages/config tzCheckFor, tzdata 2026b+). */
export const BC_TZ_CHECK = { at: "2026-12-15T20:00:00Z", offsetMinutes: -420, fixedSince: "2026-03-08T10:00:00.000Z" };
export const BC_RULE = { timeZone: "America/Vancouver", fixedSinceMs: Date.parse(BC_TZ_CHECK.fixedSince), offsetMinutes: -420 };

/**
 * Plays a browser whose tzdata predates BC's 2026-11-01 change, like CI's Playwright Chromium:
 * every `Intl` question about America/Vancouver is answered with the old rules — which are
 * exactly America/Los_Angeles's (UTC-8 winters, UTC-7 summers, DST on), so the answers are
 * real ICU answers, not hand-written ones. Returns the undo.
 */
export function playOldRulesBrowser(): () => void {
  const Real = Intl.DateTimeFormat;
  const spy = vi.spyOn(Intl, "DateTimeFormat").mockImplementation(function (locale?: Intl.LocalesArgument, options?: Intl.DateTimeFormatOptions) {
    return new Real(locale, options?.timeZone === "America/Vancouver" ? { ...options, timeZone: "America/Los_Angeles" } : options);
  } as unknown as typeof Intl.DateTimeFormat);
  clearBcTimeCachesForTests();
  return () => {
    spy.mockRestore();
    setServerZoneRule(null);
    clearBcTimeCachesForTests();
  };
}

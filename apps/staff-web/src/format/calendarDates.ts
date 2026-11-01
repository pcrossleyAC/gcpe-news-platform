import { friendlyDateRange as contractRange, friendlySpan as contractSpan, type DatedActivity, type FriendlyDateOptions } from "@gcpe/calendar-contract";
import { zonedParts } from "./bcTime";

/**
 * calendar-contract's legacy date wording (shared with the Calendar's own exports), reading
 * BC's wall clock through format/bcTime.ts so it is right on a browser with old tzdata too.
 * The Hub imports these, never the contract's own (tests/staff-web-bc-time-guard.test.ts).
 */
export function friendlyDateRange(a: DatedActivity, o: Omit<FriendlyDateOptions, "wallClock">): string {
  return contractRange(a, { ...o, wallClock: zonedParts });
}

export function friendlySpan(at: Date, now: Date, timeZone: string): string {
  return contractSpan(at, now, timeZone, zonedParts);
}

import { freezeMessage, inFreezeWindow, type CalendarRules } from "@gcpe/calendar-contract";
import { can } from "./capabilities";
import { wallClock } from "./time";
import type { Viewer } from "./visibility";

/** HTTP 423 with legacy's message. */
export class FreezeError extends Error {
  override name = "FreezeError";
}

export interface FreezeState {
  start: string;
  end: string;
  timeZone: string;
  /** The window is in force now. */
  active: boolean;
  /** …and this viewer is not exempt. */
  appliesToYou: boolean;
  message: string;
}

export function freezeStateAt(now: Date, u: Viewer, rules: CalendarRules): FreezeState {
  const { start, end } = rules.freeze;
  const active = inFreezeWindow(wallClock(now, rules.timeZone).secondsOfDay, start, end);
  return { start, end, timeZone: rules.timeZone, active, appliesToYou: active && !can.skipFreeze(u), message: freezeMessage(start, end) };
}

/** Every content write calls this with the write's own database time, so an edit started before
 * the window and saved inside it is refused (spec addendum §7.4; legacy only checked page loads). */
export function assertNotFrozen(now: Date, u: Viewer, rules: CalendarRules): void {
  const state = freezeStateAt(now, u, rules);
  if (state.appliesToYou) throw new FreezeError(state.message);
}

// Pure Calendar grant rules (spec addendum §4, C125). No runtime imports beyond ./roles, so
// staff-web's mirror test can import this file directly.
import { CALENDAR_ROLES, type CalendarRole } from "./roles";

export const CALENDAR_LEVELS: Readonly<Record<CalendarRole, number>> = Object.fromEntries(CALENDAR_ROLES.map((r, i) => [r, i + 1])) as Record<CalendarRole, number>;

export function isCalendarRole(role: string): role is CalendarRole {
  return (CALENDAR_ROLES as readonly string[]).includes(role);
}

/** The level of the Calendar role among `roles` (every check is "level ≥ n"); 0 for none. */
export function calendarLevel(roles: readonly string[]): number {
  return Math.max(0, ...roles.filter(isCalendarRole).map((r) => CALENDAR_LEVELS[r]));
}

/** The highest Calendar role an actor may grant, or null when they may grant none (C125). */
export function grantCeiling(actorRoles: readonly string[]): CalendarRole | null {
  if (actorRoles.includes("Core.Admin") || actorRoles.includes("Calendar.SysAdmin")) return "Calendar.SysAdmin";
  if (actorRoles.includes("Calendar.Administrator")) return "Calendar.Administrator";
  return null;
}

export type CalendarGrantRefusal = "not-an-administrator" | "own-access" | "target-above-ceiling" | "above-ceiling" | "hq-organization" | "hq-target";

export interface CalendarGrantCheck {
  actorId: string;
  actorRoles: readonly string[];
  /** The actor belongs to an HQ organization. */
  actorIsHq: boolean;
  /** The row id read back from the database for the account being changed — never a raw request
   * parameter, which an actor can set to any string, including a differently-cased copy of
   * their own id. */
  targetId: string;
  /** The target's Calendar role before this change. */
  targetRole: CalendarRole | null;
  nextRole: CalendarRole | null;
  /** The change gives the target an HQ organization they don't already have. */
  addsHqOrganization: boolean;
  /** The target holds an HQ ministry now, or will after this change, regardless of whether this
   * particular change is what adds it. */
  targetHasHqAfter: boolean;
}

/** Lowercases and trims, so two different-cased copies of the same id are never mistaken for
 * different accounts, nor the same id mistaken for a different one by stray whitespace. */
function canonicalId(id: string): string {
  return id.trim().toLowerCase();
}

/**
 * Why this Calendar access change is refused, or null when it is allowed. Checked in a fixed
 * order so the reason returned is the one staff can act on first. Legacy's admin pages let
 * anyone set any role, including SysAdmin, on anyone, including themself (C125).
 */
export function checkCalendarGrant(c: CalendarGrantCheck): CalendarGrantRefusal | null {
  const ceiling = grantCeiling(c.actorRoles);
  if (!ceiling) return "not-an-administrator";
  if (!c.actorRoles.includes("Core.Admin") && canonicalId(c.actorId) === canonicalId(c.targetId)) return "own-access";
  const max = CALENDAR_LEVELS[ceiling];
  if (c.targetRole && CALENDAR_LEVELS[c.targetRole] > max) return "target-above-ceiling";
  if (c.nextRole && CALENDAR_LEVELS[c.nextRole] > max) return "above-ceiling";
  // HQ sees every ministry, so only someone who already has that reach (or a SysAdmin) hands it out.
  if (c.addsHqOrganization && max < CALENDAR_LEVELS["Calendar.SysAdmin"] && !c.actorIsHq) return "hq-organization";
  // An HQ user's Calendar access, whatever it is, is an HQ Administrator's, a SysAdmin's or a
  // Core.Admin's to change — not a non-HQ Administrator's, even without touching the
  // organization itself.
  if (c.targetHasHqAfter && max < CALENDAR_LEVELS["Calendar.SysAdmin"] && !c.actorIsHq) return "hq-target";
  return null;
}

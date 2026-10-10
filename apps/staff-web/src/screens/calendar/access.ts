/** The Calendar section appears for any Calendar role in the session (spec addendum §8). What
 * each screen offers comes from GET /calendar/api/me, which the server re-derives per request. */
export function hasCalendarRole(s: { roles: readonly string[] }): boolean {
  return s.roles.some((r) => r.startsWith("Calendar."));
}

/** Administrator and above see the Calendar's admin screens (spec addendum §6, "Lookups, users, Transfer"). */
export const CALENDAR_ADMIN_LEVEL = 4;

/** System Administrators see the Calendar's undelivered-events page (spec addendum §5.1). */
export const CALENDAR_SYSADMIN_LEVEL = 5;

export interface CalendarMe {
  userId: string;
  displayName: string;
  role: string;
  level: number;
  ministryKeys: string[];
  isHq: boolean;
}

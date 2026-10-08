/**
 * The Calendar roles with legacy's labels (Calendar/Admin/User.aspx:120-124), lowest to highest.
 * Mirrors packages/auth's CALENDAR_ROLES and grant ceiling: browser code can't import
 * @gcpe/auth (it pulls in express and jose). calendar-roles.test.ts keeps both equal to the
 * server's. The server still decides every grant; this only decides what the screen offers.
 */
export const CALENDAR_ROLE_INFO = [
  { role: "Calendar.ReadOnly", label: "Read Only" },
  { role: "Calendar.Editor", label: "Editor" },
  { role: "Calendar.Advanced", label: "Advanced" },
  { role: "Calendar.Administrator", label: "Administrator" },
  { role: "Calendar.SysAdmin", label: "System Administrator" },
] as const;

export type CalendarRoleName = (typeof CALENDAR_ROLE_INFO)[number]["role"];

interface HasRole {
  has(role: string): boolean;
}

/** Who may open Calendar access: the server gates the same three roles. */
export const CALENDAR_ACCESS_ROLES: readonly string[] = ["Core.Admin", "Calendar.Administrator", "Calendar.SysAdmin"];

export function canManageCalendarAccess(s: HasRole): boolean {
  return CALENDAR_ACCESS_ROLES.some((r) => s.has(r));
}

export function levelOf(role: CalendarRoleName | null): number {
  return role ? CALENDAR_ROLE_INFO.findIndex((r) => r.role === role) + 1 : 0;
}

/** The highest level this session may grant: 5 for Core.Admin or System Administrator, 4 for Administrator, else 0. */
export function ceilingLevel(s: HasRole): number {
  if (s.has("Core.Admin") || s.has("Calendar.SysAdmin")) return 5;
  if (s.has("Calendar.Administrator")) return 4;
  return 0;
}

export function grantableCalendarRoles(s: HasRole): (typeof CALENDAR_ROLE_INFO)[number][] {
  const max = ceilingLevel(s);
  return CALENDAR_ROLE_INFO.filter((_, i) => i + 1 <= max);
}

export function calendarRoleLabel(role: CalendarRoleName): string {
  return CALENDAR_ROLE_INFO.find((r) => r.role === role)!.label;
}

export type CalendarGrantRefusal = "not-an-administrator" | "own-access" | "target-above-ceiling" | "above-ceiling" | "hq-organization" | "hq-target";

export interface CalendarGrantCheck {
  actorId: string;
  actorRoles: readonly string[];
  actorIsHq: boolean;
  targetId: string;
  targetRole: CalendarRoleName | null;
  nextRole: CalendarRoleName | null;
  addsHqOrganization: boolean;
  targetHasHqAfter: boolean;
}

function canonicalId(id: string): string {
  return id.trim().toLowerCase();
}

/**
 * Mirrors the server's checkCalendarGrant exactly (packages/auth/src/calendar-roles.ts):
 * browser code can't import @gcpe/auth, so the screen that offers or hides an action duplicates
 * this pure logic rather than calling the server before every render. The server still decides
 * every grant on submit; calendar-roles.test.ts runs both over a generated matrix to keep this
 * copy equal to the server's.
 */
export function checkCalendarGrant(c: CalendarGrantCheck): CalendarGrantRefusal | null {
  const max = ceilingLevel({ has: (r) => c.actorRoles.includes(r) });
  if (max === 0) return "not-an-administrator";
  if (!c.actorRoles.includes("Core.Admin") && canonicalId(c.actorId) === canonicalId(c.targetId)) return "own-access";
  if (c.targetRole && levelOf(c.targetRole) > max) return "target-above-ceiling";
  if (c.nextRole && levelOf(c.nextRole) > max) return "above-ceiling";
  if (c.addsHqOrganization && max < 5 && !c.actorIsHq) return "hq-organization";
  if (c.targetHasHqAfter && max < 5 && !c.actorIsHq) return "hq-target";
  return null;
}

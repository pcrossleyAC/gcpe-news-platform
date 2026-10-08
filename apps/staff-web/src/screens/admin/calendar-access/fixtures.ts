import type { CalendarAccessUser, OrgOption } from "./CalendarAccessScreen";

export const ORGS: OrgOption[] = [
  { key: "health", displayName: "Health", abbreviation: "HLTH", isActive: true, isHq: false },
  { key: "gcpe-headquarters", displayName: "GCPE Headquarters", abbreviation: "GCPEHQ", isActive: true, isHq: true },
  { key: "retired", displayName: "Retired Ministry", abbreviation: "RET", isActive: false, isHq: false },
];
export const SELF: CalendarAccessUser = { id: "self-1", email: "sam.self@x.invalid", displayName: "Sam Self", isActive: true, calendarRole: "Calendar.Administrator", organizationKeys: ["health"] };
export const STAFF: CalendarAccessUser = { id: "staff-1", email: "robin.staff@x.invalid", displayName: "Robin Staff", isActive: true, calendarRole: null, organizationKeys: [] };
export const SYSADMIN: CalendarAccessUser = { id: "sys-1", email: "lee.sys@x.invalid", displayName: "Lee Sys", isActive: true, calendarRole: "Calendar.SysAdmin", organizationKeys: ["health"] };
export const IMPORTED: CalendarAccessUser = { id: "old-1", email: null, displayName: "Kim Imported", isActive: false, calendarRole: "Calendar.Editor", organizationKeys: ["retired"] };
export const ACCESS_USERS: CalendarAccessUser[] = [SELF, STAFF, SYSADMIN, IMPORTED];

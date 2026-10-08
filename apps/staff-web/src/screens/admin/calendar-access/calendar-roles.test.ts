import { describe, expect, it } from "vitest";
// Imported by relative path, bypassing the @gcpe/auth barrel (Node-only): these two files have
// no runtime imports beyond each other, so the test sees the server's real rules.
import { CALENDAR_ROLES } from "../../../../../../packages/auth/src/roles";
import { CALENDAR_LEVELS, grantCeiling } from "../../../../../../packages/auth/src/calendar-roles";
import { CALENDAR_ROLE_INFO, calendarRoleLabel, canManageCalendarAccess, ceilingLevel, grantableCalendarRoles, levelOf } from "./calendar-roles";

const ROLE_SETS: string[][] = [
  [],
  ["Core.Admin"],
  ["Calendar.SysAdmin"],
  ["Calendar.Administrator"],
  ["Calendar.Advanced"],
  ["Calendar.Editor"],
  ["Calendar.ReadOnly"],
  ["NRMS.Editor", "NoD.Admin"],
  ["Core.Admin", "Calendar.ReadOnly"],
];
const sessionOf = (roles: string[]) => ({ has: (r: string) => roles.includes(r) });

describe("staff-web's Calendar roles", () => {
  it("names the server's Calendar roles, in the same order", () => {
    expect(CALENDAR_ROLE_INFO.map((r) => r.role)).toEqual([...CALENDAR_ROLES]);
  });

  it("uses legacy's labels", () => {
    expect(CALENDAR_ROLE_INFO.map((r) => r.label)).toEqual(["Read Only", "Editor", "Advanced", "Administrator", "System Administrator"]);
    expect(calendarRoleLabel("Calendar.SysAdmin")).toBe("System Administrator");
  });

  it("offers exactly the roles the server lets each actor grant", () => {
    for (const roles of ROLE_SETS) {
      const ceiling = grantCeiling(roles);
      const max = ceiling ? CALENDAR_LEVELS[ceiling] : 0;
      expect(ceilingLevel(sessionOf(roles))).toBe(max);
      expect(grantableCalendarRoles(sessionOf(roles)).map((r) => r.role)).toEqual(CALENDAR_ROLES.filter((r) => CALENDAR_LEVELS[r] <= max));
      expect(canManageCalendarAccess(sessionOf(roles))).toBe(max > 0);
    }
  });

  it("levelOf matches the server's levels; no role is 0", () => {
    for (const r of CALENDAR_ROLES) expect(levelOf(r)).toBe(CALENDAR_LEVELS[r]);
    expect(levelOf(null)).toBe(0);
  });
});

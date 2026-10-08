import { describe, expect, it } from "vitest";
// Imported by relative path, bypassing the @gcpe/auth barrel (Node-only): these two files have
// no runtime imports beyond each other, so the test sees the server's real rules.
import { CALENDAR_ROLES, STAFF_ROLES } from "../../../../../../packages/auth/src/roles";
import { CALENDAR_LEVELS, checkCalendarGrant as serverCheckCalendarGrant, grantCeiling } from "../../../../../../packages/auth/src/calendar-roles";
import {
  CALENDAR_ACCESS_ROLES,
  CALENDAR_ROLE_INFO,
  calendarRoleLabel,
  canManageCalendarAccess,
  ceilingLevel,
  checkCalendarGrant as clientCheckCalendarGrant,
  grantableCalendarRoles,
  levelOf,
  type CalendarGrantCheck,
  type CalendarRoleName,
} from "./calendar-roles";

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

  it("CALENDAR_ACCESS_ROLES is exactly the roles that grant Calendar access on the server", () => {
    const candidates = [...STAFF_ROLES, ...CALENDAR_ROLES];
    const granting = candidates.filter((r) => grantCeiling([r]) !== null);
    expect(new Set(CALENDAR_ACCESS_ROLES)).toEqual(new Set(granting));
  });
});

describe("the screen's checkCalendarGrant mirrors the server's", () => {
  it("agrees with the server over a generated matrix of actor/target/next combinations", () => {
    const actorRolesOptions: readonly string[][] = [
      [],
      ["Core.Admin"],
      ["Calendar.SysAdmin"],
      ["Calendar.Administrator"],
      ["Calendar.Advanced"],
      ["NRMS.Editor", "NoD.Admin"],
    ];
    const roleOptions: readonly (CalendarRoleName | null)[] = [null, ...CALENDAR_ROLES];
    const bools = [false, true];
    let cases = 0;
    for (const actorRoles of actorRolesOptions) {
      for (const actorIsHq of bools) {
        for (const sameId of bools) {
          for (const targetRole of roleOptions) {
            for (const nextRole of roleOptions) {
              for (const addsHqOrganization of bools) {
                for (const targetHasHqAfter of bools) {
                  const check: CalendarGrantCheck = {
                    actorId: "actor",
                    actorRoles,
                    actorIsHq,
                    targetId: sameId ? "actor" : "target",
                    targetRole,
                    nextRole,
                    addsHqOrganization,
                    targetHasHqAfter,
                  };
                  expect(clientCheckCalendarGrant(check)).toBe(serverCheckCalendarGrant(check));
                  cases++;
                }
              }
            }
          }
        }
      }
    }
    expect(cases).toBeGreaterThan(1000);
  });
});

import { describe, expect, it } from "vitest";
import { CALENDAR_LEVELS, calendarLevel, checkCalendarGrant, grantCeiling, isCalendarRole, type CalendarGrantCheck } from "./calendar-roles";
import { CALENDAR_ROLES, STAFF_ROLES } from "./roles";

const grant = (over: Partial<CalendarGrantCheck>): CalendarGrantCheck => ({
  actorId: "actor",
  actorRoles: ["Calendar.Administrator"],
  actorIsHq: false,
  targetId: "target",
  targetRole: null,
  nextRole: "Calendar.Editor",
  addsHqOrganization: false,
  targetHasHqAfter: false,
  ...over,
});

describe("Calendar roles", () => {
  it("run 1–5 in legacy's SecurityRole order", () => {
    expect([...CALENDAR_ROLES]).toEqual(["Calendar.ReadOnly", "Calendar.Editor", "Calendar.Advanced", "Calendar.Administrator", "Calendar.SysAdmin"]);
    expect(CALENDAR_ROLES.map((r) => CALENDAR_LEVELS[r])).toEqual([1, 2, 3, 4, 5]);
  });

  it("are kept out of the flat staff roles", () => {
    for (const r of CALENDAR_ROLES) expect(STAFF_ROLES as readonly string[]).not.toContain(r);
    expect(isCalendarRole("Calendar.Editor")).toBe(true);
    expect(isCalendarRole("NRMS.Editor")).toBe(false);
    expect(isCalendarRole("Calendar.Owner")).toBe(false);
  });

  it("calendarLevel reads the Calendar role among a user's roles; none is 0", () => {
    expect(calendarLevel(["NRMS.Editor", "Calendar.Advanced"])).toBe(3);
    expect(calendarLevel(["NRMS.Editor"])).toBe(0);
    expect(calendarLevel([])).toBe(0);
  });

  it("grantCeiling: Core.Admin and SysAdmin grant up to SysAdmin, Administrator up to Administrator, anyone else nothing", () => {
    expect(grantCeiling(["Core.Admin"])).toBe("Calendar.SysAdmin");
    expect(grantCeiling(["Calendar.SysAdmin"])).toBe("Calendar.SysAdmin");
    expect(grantCeiling(["Calendar.Administrator"])).toBe("Calendar.Administrator");
    expect(grantCeiling(["Calendar.Advanced", "NRMS.Editor", "NoD.Admin"])).toBeNull();
    expect(grantCeiling([])).toBeNull();
  });
});

describe("checkCalendarGrant", () => {
  it("an Administrator grants every role up to Administrator, never SysAdmin (C125)", () => {
    for (const nextRole of ["Calendar.ReadOnly", "Calendar.Editor", "Calendar.Advanced", "Calendar.Administrator", null] as const) {
      expect(checkCalendarGrant(grant({ nextRole }))).toBeNull();
    }
    expect(checkCalendarGrant(grant({ nextRole: "Calendar.SysAdmin" }))).toBe("above-ceiling");
  });

  it("an Administrator can't change a SysAdmin's access, even to lower or remove it", () => {
    expect(checkCalendarGrant(grant({ targetRole: "Calendar.SysAdmin", nextRole: "Calendar.ReadOnly" }))).toBe("target-above-ceiling");
    expect(checkCalendarGrant(grant({ targetRole: "Calendar.SysAdmin", nextRole: null }))).toBe("target-above-ceiling");
  });

  it("a SysAdmin and a Core.Admin grant and remove SysAdmin", () => {
    expect(checkCalendarGrant(grant({ actorRoles: ["Calendar.SysAdmin"], nextRole: "Calendar.SysAdmin" }))).toBeNull();
    expect(checkCalendarGrant(grant({ actorRoles: ["Core.Admin"], targetRole: "Calendar.SysAdmin", nextRole: null }))).toBeNull();
  });

  it("nobody but a Core.Admin changes their own Calendar access", () => {
    expect(checkCalendarGrant(grant({ targetId: "actor" }))).toBe("own-access");
    expect(checkCalendarGrant(grant({ actorRoles: ["Calendar.SysAdmin"], targetId: "actor" }))).toBe("own-access");
    expect(checkCalendarGrant(grant({ actorRoles: ["Core.Admin"], targetId: "actor", nextRole: "Calendar.SysAdmin" }))).toBeNull();
  });

  it("compares ids canonically, so a differently-cased copy of your own id doesn't let you through", () => {
    expect(checkCalendarGrant(grant({ actorId: "11111111-AAAA-1111-aaaa-111111111111", targetId: "11111111-aaaa-1111-AAAA-111111111111" }))).toBe("own-access");
    expect(checkCalendarGrant(grant({ actorId: " actor ", targetId: "actor" }))).toBe("own-access");
  });

  it("an Administrator may change or demote another Administrator", () => {
    expect(checkCalendarGrant(grant({ targetRole: "Calendar.Administrator", nextRole: "Calendar.ReadOnly" }))).toBeNull();
    expect(checkCalendarGrant(grant({ targetRole: "Calendar.Administrator", nextRole: null }))).toBeNull();
  });

  it("adding an HQ organization takes an HQ Administrator, a SysAdmin or a Core.Admin", () => {
    expect(checkCalendarGrant(grant({ addsHqOrganization: true }))).toBe("hq-organization");
    expect(checkCalendarGrant(grant({ addsHqOrganization: true, actorIsHq: true }))).toBeNull();
    expect(checkCalendarGrant(grant({ addsHqOrganization: true, actorRoles: ["Calendar.SysAdmin"] }))).toBeNull();
    expect(checkCalendarGrant(grant({ addsHqOrganization: true, actorRoles: ["Core.Admin"] }))).toBeNull();
  });

  it("a non-HQ Administrator can't raise an HQ user's role, even within their own ceiling", () => {
    for (const nextRole of ["Calendar.Advanced", "Calendar.Administrator"] as const) {
      expect(checkCalendarGrant(grant({ targetRole: "Calendar.ReadOnly", nextRole, targetHasHqAfter: true }))).toBe("hq-target");
    }
  });

  it("a non-HQ Administrator can't remove an HQ user's access either", () => {
    expect(checkCalendarGrant(grant({ targetRole: "Calendar.ReadOnly", nextRole: null, targetHasHqAfter: true }))).toBe("hq-target");
  });

  it("an HQ Administrator may do both", () => {
    expect(checkCalendarGrant(grant({ actorIsHq: true, targetRole: "Calendar.ReadOnly", nextRole: "Calendar.Administrator", targetHasHqAfter: true }))).toBeNull();
    expect(checkCalendarGrant(grant({ actorIsHq: true, targetRole: "Calendar.ReadOnly", nextRole: null, targetHasHqAfter: true }))).toBeNull();
  });

  it("a SysAdmin and a Core.Admin bypass the HQ-target rule too", () => {
    expect(checkCalendarGrant(grant({ actorRoles: ["Calendar.SysAdmin"], targetRole: "Calendar.ReadOnly", nextRole: null, targetHasHqAfter: true }))).toBeNull();
    expect(checkCalendarGrant(grant({ actorRoles: ["Core.Admin"], targetRole: "Calendar.ReadOnly", nextRole: null, targetHasHqAfter: true }))).toBeNull();
  });

  it("refuses anyone below Administrator whatever they ask for", () => {
    for (const actorRoles of [[], ["Calendar.Advanced"], ["Calendar.Editor"], ["Calendar.ReadOnly"], ["NRMS.Editor", "NoD.Admin"]]) {
      expect(checkCalendarGrant(grant({ actorRoles, nextRole: null }))).toBe("not-an-administrator");
    }
  });

  it("being in an HQ organization doesn't substitute for holding an administrator role", () => {
    expect(checkCalendarGrant(grant({ actorRoles: ["Calendar.Advanced"], actorIsHq: true, addsHqOrganization: true, targetHasHqAfter: true }))).toBe("not-an-administrator");
  });

  it("reports the first refusal in a fixed order, so staff see the reason they can act on", () => {
    // Own access outranks the role ceiling: an Administrator asking for SysAdmin for themself is told about themself.
    expect(checkCalendarGrant(grant({ targetId: "actor", nextRole: "Calendar.SysAdmin" }))).toBe("own-access");
    // A SysAdmin target outranks the requested role.
    expect(checkCalendarGrant(grant({ targetRole: "Calendar.SysAdmin", nextRole: "Calendar.SysAdmin", addsHqOrganization: true }))).toBe("target-above-ceiling");
    // The role ceiling outranks the HQ rules.
    expect(checkCalendarGrant(grant({ nextRole: "Calendar.SysAdmin", addsHqOrganization: true, targetHasHqAfter: true }))).toBe("above-ceiling");
    // Adding an HQ organization outranks the plain HQ-target rule below it: both need the same
    // reach, but the organization change is the more specific reason staff can act on.
    expect(checkCalendarGrant(grant({ addsHqOrganization: true, targetHasHqAfter: true }))).toBe("hq-organization");
  });
});

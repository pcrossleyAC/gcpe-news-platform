import { describe, expect, it } from "vitest";
import { canChangeCalendar, hasCalendarRole } from "./access";

describe("hasCalendarRole", () => {
  it("is true for any Calendar role and false otherwise", () => {
    expect(hasCalendarRole({ roles: ["Calendar.ReadOnly"] })).toBe(true);
    expect(hasCalendarRole({ roles: ["NRMS.Editor", "Calendar.SysAdmin"] })).toBe(true);
    expect(hasCalendarRole({ roles: ["Core.Admin", "NoD.Admin"] })).toBe(false);
  });
});

describe("canChangeCalendar", () => {
  it("is true for Editor and above, false for Read Only and for no Calendar role", () => {
    for (const r of ["Calendar.Editor", "Calendar.Advanced", "Calendar.Administrator", "Calendar.SysAdmin"]) expect(canChangeCalendar({ roles: [r] })).toBe(true);
    expect(canChangeCalendar({ roles: ["Calendar.ReadOnly"] })).toBe(false);
    expect(canChangeCalendar({ roles: ["NRMS.Editor", "Calendar.ReadOnly"] })).toBe(false);
    expect(canChangeCalendar({ roles: ["Core.Admin"] })).toBe(false);
  });
});

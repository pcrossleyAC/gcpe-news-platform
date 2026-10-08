import { describe, expect, it } from "vitest";
import { hasCalendarRole } from "./access";

describe("hasCalendarRole", () => {
  it("is true for any Calendar role and false otherwise", () => {
    expect(hasCalendarRole({ roles: ["Calendar.ReadOnly"] })).toBe(true);
    expect(hasCalendarRole({ roles: ["NRMS.Editor", "Calendar.SysAdmin"] })).toBe(true);
    expect(hasCalendarRole({ roles: ["Core.Admin", "NoD.Admin"] })).toBe(false);
  });
});

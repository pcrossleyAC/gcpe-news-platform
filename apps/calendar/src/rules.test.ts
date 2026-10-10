import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { CALENDAR_LEVELS } from "@gcpe/auth";
import { loadTenantConfig } from "@gcpe/config";
import { LEVEL } from "@gcpe/calendar-contract";
import { rulesFromTenant } from "./rules";

const tenant = (name: string) => loadTenantConfig(fileURLToPath(new URL(`../../../config/tenants/${name}.json`, import.meta.url)));

describe("rulesFromTenant", () => {
  it("joins the tenant's time zone to its calendar section", () => {
    const rules = rulesFromTenant(tenant("bc"));
    expect(rules.timeZone).toBe("America/Vancouver");
    expect(rules.freeze).toEqual({ start: "16:00", end: "17:00" });
  });

  it("refuses a tenant with no calendar section, naming it", () => {
    expect(() => rulesFromTenant(tenant("nb"))).toThrow(/tenant "nb" has no "calendar" section/);
  });

  it("the contract's levels mirror the auth package's", () => {
    expect(LEVEL).toEqual({
      readOnly: CALENDAR_LEVELS["Calendar.ReadOnly"],
      editor: CALENDAR_LEVELS["Calendar.Editor"],
      advanced: CALENDAR_LEVELS["Calendar.Advanced"],
      administrator: CALENDAR_LEVELS["Calendar.Administrator"],
      sysAdmin: CALENDAR_LEVELS["Calendar.SysAdmin"],
    });
  });
});

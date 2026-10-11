import { describe, expect, it } from "vitest";
import { activityScopeSql, Q } from "./queries";

describe("legacy queries", () => {
  it("puts the cutoff in SQL Server's unambiguous YYYYMMDD form, and the awareness ids as integers", () => {
    const s = activityScopeSql("2027-01-15", [2]);
    expect(s).toContain("a.EndDateTime >= '20270115'");
    expect(s).toContain("a.StartDateTime >= '20270115'");
    expect(s).toContain("ac.CategoryId IN (2)");
    expect(s).toContain("a.IsActive = 1");
  });
  it("refuses anything that isn't a plain date or a positive integer id, so nothing reaches SQL unchecked", () => {
    expect(() => activityScopeSql("2027-01-15'; DROP TABLE x;--", [2])).toThrow();
    expect(() => activityScopeSql("15/01/2027", [2])).toThrow();
    expect(() => activityScopeSql("2027-01-15", [2.5])).toThrow();
    expect(() => activityScopeSql("2027-01-15", [-1])).toThrow();
  });
  it("matches nothing for awareness when the tenant lists no awareness category", () => {
    expect(activityScopeSql("2027-01-15", [])).toContain("1 = 0");
  });
  it("names every query on its first line, as the fake source requires", () => {
    for (const sql of Object.values(Q("2027-01-15", [2]))) expect(sql).toMatch(/^-- name: \S+\n/);
  });
});

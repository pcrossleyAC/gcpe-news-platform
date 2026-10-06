import { describe, expect, it } from "vitest";
import { canManageWebsite, canReadWebsite } from "./access";

function sessionWith(roles: string[]) {
  return { has: (r: string) => roles.includes(r) } as { has(role: string): boolean };
}

describe("canReadWebsite / canManageWebsite (minors)", () => {
  it.each(["NRMS.Viewer", "NRMS.Editor", "NRMS.SiteEditor", "Core.Admin"])("%s can read Website", (role) => {
    expect(canReadWebsite(sessionWith([role]) as never)).toBe(true);
  });

  it("no staff role at all cannot read Website", () => {
    expect(canReadWebsite(sessionWith([]) as never)).toBe(false);
  });

  it.each(["NRMS.SiteEditor", "Core.Admin"])("%s can manage Website", (role) => {
    expect(canManageWebsite(sessionWith([role]) as never)).toBe(true);
  });

  it.each(["NRMS.Viewer", "NRMS.Editor"])("%s cannot manage Website (read-only Featured/Log only)", (role) => {
    expect(canManageWebsite(sessionWith([role]) as never)).toBe(false);
  });
});

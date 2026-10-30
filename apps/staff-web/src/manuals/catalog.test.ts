import { describe, expect, it } from "vitest";
import type { SessionValue } from "../session/SessionContext";
import { MANUALS, visibleManuals } from "./catalog";

const as = (...roles: string[]): SessionValue => ({ roles, has: (r: string) => roles.includes(r) }) as unknown as SessionValue;

describe("visibleManuals", () => {
  it("shows a Core administrator every manual, core-admin first", () => {
    const v = visibleManuals(as("Core.Admin"));
    expect(v).toHaveLength(11);
    expect(v[0]).toBe("core-admin");
    expect(new Set(v)).toEqual(new Set(MANUALS.map((m) => m.id)));
  });
  it("shows a site editor their manual and the lower NRMS ones", () => {
    expect(visibleManuals(as("NRMS.SiteEditor"))).toEqual(["nrms-site-editor", "nrms-editor", "nrms-viewer"]);
  });
  it("lists own manuals first (by app), then lower ones", () => {
    expect(visibleManuals(as("NRMS.Editor", "Calendar.ReadOnly"))).toEqual(["nrms-editor", "calendar-readonly", "nrms-viewer"]);
  });
  it("gives a Calendar administrator the admin manual and the three below", () => {
    expect(visibleManuals(as("Calendar.Administrator"))).toEqual(["calendar-admin", "calendar-advanced", "calendar-editor", "calendar-readonly"]);
    expect(visibleManuals(as("Calendar.SysAdmin"))[0]).toBe("calendar-admin");
  });
  it("never shows a manual above the user's role or in an app they have no role in", () => {
    expect(visibleManuals(as("NoD.Viewer"))).toEqual(["nod-viewer"]);
    expect(visibleManuals(as("NoD.Editor"))).toEqual(["nod-editor", "nod-viewer"]);
  });
  it("shows nothing to a user with no role", () => {
    expect(visibleManuals(as())).toEqual([]);
  });
});

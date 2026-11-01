import { describe, expect, it } from "vitest";
import { describeEntry, type AuditEntry } from "./describe";

const entry = (action: string, details: Record<string, unknown> = {}, over: Partial<AuditEntry> = {}): AuditEntry => ({
  id: 1,
  at: "2026-10-31T17:00:00Z",
  actorId: "a",
  actorName: "Paul Smith",
  action,
  targetType: action.startsWith("org.") ? "organization" : action.startsWith("term.") ? "term" : action.startsWith("cabinet.") ? "cabinet-change" : "user",
  targetId: "t",
  targetLabel: "Jo Lee",
  details,
  ...over,
});
const orgNames = new Map([
  ["health", "Health"],
  ["finance", "Finance"],
]);
const say = (e: AuditEntry) => describeEntry(e, (k) => orgNames.get(k));

/** Suite review O3: each audit entry as one plain sentence, after the name of who made it. */
describe("describeEntry", () => {
  it("users: roles by their names on the Users screen", () => {
    expect(say(entry("user.roles", { added: ["Core.Admin"], removed: [] }))).toBe("gave Core Admin to Jo Lee");
    expect(say(entry("user.roles", { added: ["NRMS.SiteEditor", "NoD.Viewer"], removed: ["NRMS.Viewer"] }))).toBe("gave NRMS Site editor and NoD Viewer to Jo Lee, and took NRMS Viewer from them");
    expect(say(entry("user.roles", { added: [], removed: ["Core.Admin"] }))).toBe("took Core Admin from Jo Lee");
    expect(say(entry("user.created", { email: "jo@x", roles: ["NRMS.Editor"], isActive: true }))).toBe("added Jo Lee (jo@x) with NRMS Editor");
    expect(say(entry("user.created", { email: "jo@x", roles: [], isActive: true }))).toBe("added Jo Lee (jo@x) with no roles");
    expect(say(entry("user.renamed", { from: "Jo Lee", to: "Jo Lee-Park" }))).toBe("renamed Jo Lee to Jo Lee-Park");
    expect(say(entry("user.deactivated"))).toBe("deactivated Jo Lee");
    expect(say(entry("user.activated"))).toBe("reactivated Jo Lee");
    expect(say(entry("user.password-set"))).toBe("set a new password for Jo Lee");
    expect(say(entry("user.linked", { email: "jo@x" }))).toBe("linked Jo Lee to jo@x and activated them");
    expect(say(entry("user.microsoft-unlinked"))).toBe("unlinked Jo Lee from Microsoft sign-in");
    expect(say(entry("user.microsoft-linked"))).toBe("signed in with Microsoft for the first time, which linked their account");
    expect(say(entry("core.republished", { enqueued: 42 }, { targetType: "core" }))).toBe("sent every ministry, user, sector, theme and tag to the other apps again (42 records)");
  });

  it("Calendar access: role labels and ministry names", () => {
    expect(say(entry("calendar.access", { role: { from: null, to: "Calendar.Editor" }, added: ["health"], removed: [] }))).toBe(
      "changed Jo Lee's Calendar access: gave them the Editor role; added Health",
    );
    expect(say(entry("calendar.access", { role: { from: "Calendar.Editor", to: "Calendar.SysAdmin" }, added: ["finance"], removed: ["health"] }))).toBe(
      "changed Jo Lee's Calendar access: changed their role from Editor to System Administrator; added Finance; removed Health",
    );
    expect(say(entry("calendar.access", { role: { from: "Calendar.Advanced", to: null }, added: [], removed: ["gone"] }))).toBe(
      "changed Jo Lee's Calendar access: took away their Advanced role; removed gone",
    );
  });

  it("organizations: renames, abbreviations, fields, flags, hand-overs, and what made the change", () => {
    const org = { targetLabel: "Ministry of Y" };
    expect(say(entry("org.edited", { name: { from: "Ministry of X", to: "Ministry of Y" }, fields: [] }, org))).toBe("renamed Ministry of X to Ministry of Y");
    expect(say(entry("org.edited", { abbreviation: { from: "MX", to: "MY" }, fields: ["minister", "contact", "topicLinks"] }, org))).toBe(
      "changed the abbreviation of Ministry of Y from MX to MY; changed Ministry of Y's minister, primary contact and Featured Topics",
    );
    expect(say(entry("org.edited", { active: { from: false, to: true }, fields: [] }, org))).toBe("reactivated Ministry of Y");
    expect(say(entry("org.edited", { name: { from: "A", to: "B" }, fields: [], via: "cabinet-change" }, org))).toBe("renamed A to B (cabinet change)");
    expect(say(entry("org.edited", { abbreviation: { from: null, to: "TRIAL" }, fields: [], via: "hand-over" }, org))).toBe("changed the abbreviation of Ministry of Y from none to TRIAL (hand-over)");
    expect(say(entry("org.created", { abbreviation: "MY" }, org))).toBe("added Ministry of Y");
    expect(say(entry("org.hq", { isHq: true }, org))).toBe("made Ministry of Y an HQ organization");
    expect(say(entry("org.hq", { isHq: false }, org))).toBe("made Ministry of Y no longer an HQ organization");
    expect(say(entry("org.public", { isPublic: false }, org))).toBe("made Ministry of Y not public");
    expect(say(entry("org.public", { isPublic: true }, org))).toBe("made Ministry of Y public");
    expect(say(entry("org.deactivated", {}, org))).toBe("deactivated Ministry of Y");
    expect(
      say(entry("org.handed-over", { successors: [{ key: "finance", name: "Finance" }, { key: "health", name: "Health" }], moveStaff: true, takeAbbreviation: true, staffMoved: 3 }, org)),
    ).toBe("handed Ministry of Y over to Finance and Health (3 staff moved)");
    expect(say(entry("org.handed-over", { successors: [{ key: "finance", name: "Finance" }], moveStaff: false, staffMoved: 0 }, org))).toBe("handed Ministry of Y over to Finance");
  });

  it("sectors, themes, tags, services and the cabinet change", () => {
    const sector = { targetLabel: "Agriculture" };
    expect(say(entry("term.created", { kind: "sector" }, sector))).toBe("added the sector Agriculture");
    expect(say(entry("term.edited", { kind: "tag", name: { from: "Farming", to: "Agriculture" }, fields: [] }, sector))).toBe("renamed the tag Farming to Agriculture");
    expect(say(entry("term.edited", { kind: "theme", fields: ["sortOrder"] }, sector))).toBe("changed the order of the theme Agriculture");
    expect(say(entry("term.edited", { kind: "service", fields: ["isActive"] }, sector))).toBe("changed the service Agriculture");
    expect(say(entry("term.deactivated", { kind: "sector" }, sector))).toBe("deactivated the sector Agriculture");
    expect(say(entry("term.edited", { kind: "sector", active: { from: false, to: true }, fields: [] }, sector))).toBe("reactivated the sector Agriculture");
    expect(say(entry("term.edited", { kind: "tag", name: { from: "Farm", to: "Agriculture" }, active: { from: true, to: false }, fields: [] }, sector))).toBe(
      "renamed the tag Farm to Agriculture; deactivated the tag Agriculture",
    );
    expect(say(entry("cabinet.saved", { operations: 2 }))).toBe("saved the cabinet change draft (2 changes)");
    expect(say(entry("cabinet.saved", { operations: 1 }))).toBe("saved the cabinet change draft (1 change)");
    expect(say(entry("cabinet.scheduled", { at: "2026-11-03T16:00:00Z" }))).toBe("scheduled the cabinet change");
    expect(describeEntry(entry("cabinet.scheduled", { at: "2026-11-03T16:00:00Z" }), () => undefined, (iso) => `[${iso}]`)).toBe("scheduled the cabinet change for [2026-11-03T16:00:00Z]");
    expect(say(entry("cabinet.cancelled"))).toBe("cancelled the cabinet change");
    expect(say(entry("cabinet.published", { operations: 3 }))).toBe("published the cabinet change (3 changes)");
  });

  it("an action the Hub doesn't know yet still reads", () => {
    expect(say(entry("user.something-new"))).toBe("changed Jo Lee");
  });
});

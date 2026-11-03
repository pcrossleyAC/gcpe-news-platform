import { describe, expect, it } from "vitest";
import { organizationName, organizationsFor, releaseMinistries } from "./categories";

const term = (key: string, name: string) => ({ key, name });
const LIST = [term("health", "Health"), term("gcpehq", "GCPE Headquarters"), term("mos-local", "Minister of State for Local Governments"), term("child", "Workforce Development")];
const ORGS = [
  { key: "HEALTH", parentKey: null, isPublic: true },
  { key: "gcpehq", parentKey: null, isPublic: false },
  { key: "mos-local", parentKey: null, isPublic: true },
  { key: "child", parentKey: "health", isPublic: true },
];
const keys = (l: { key: string }[]) => l.map((t) => t.key);

describe("releaseMinistries (C326)", () => {
  it("leaves out what isn't public, a ministry with a parent, and a name legacy's test catches; keys compare case-insensitively", () => {
    expect(keys(releaseMinistries(LIST, ORGS, []))).toEqual(["health"]);
  });

  it("keeps any the release already has, so it can be unticked", () => {
    expect(keys(releaseMinistries(LIST, ORGS, ["gcpehq", "child"]))).toEqual(["health", "gcpehq", "child"]);
  });

  it("without Core's list, only legacy's name test applies", () => {
    expect(keys(releaseMinistries(LIST, null, []))).toEqual(["health", "gcpehq", "child"]);
  });
});

describe("organizationName / organizationsFor (C328)", () => {
  it("a ministry gets legacy's English name; a body that names itself keeps its name", () => {
    expect(organizationName("Citizens' Services")).toBe("Ministry of Citizens' Services");
    expect(organizationName("Attorney General")).toBe("Ministry of Attorney General");
    expect(organizationName("Office of the Premier")).toBe("Office of the Premier");
    expect(organizationName("Intergovernmental Relations Secretariat")).toBe("Intergovernmental Relations Secretariat");
    expect(organizationName("Minister of State for Trade")).toBe("Minister of State for Trade");
  });

  it("the ticked ministries, one per line, in the order ticked", () => {
    const list = [term("health", "Health"), term("premier", "Office of the Premier")];
    expect(organizationsFor(["premier", "health"], list)).toBe("Office of the Premier\nMinistry of Health");
    expect(organizationsFor([], list)).toBe("");
  });
});

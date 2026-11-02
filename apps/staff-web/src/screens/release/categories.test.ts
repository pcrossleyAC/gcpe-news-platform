import { describe, expect, it } from "vitest";
import { releaseMinistries } from "./categories";

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

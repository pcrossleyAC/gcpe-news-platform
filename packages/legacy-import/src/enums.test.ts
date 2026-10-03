import { describe, expect, it } from "vitest";
import { LANGUAGE_BY_LCID, PUBLISH_OPTIONS, hasPublishOption, releaseKindFromLegacy } from "./enums";

describe("legacy enums", () => {
  // Legacy: Gcpe.Hub.Data_Legacy/Entity/ReleaseType.cs:16-20 and HubEntitiesExtensions.ReleasePathName
  it("maps ReleaseType 1..5 to post kinds (guards against the nrms 0..4 off-by-one)", () => {
    expect([1, 2, 3, 4, 5].map(releaseKindFromLegacy)).toEqual(["releases", "stories", "factsheets", "updates", "advisories"]);
  });

  it("throws on unknown release types, including 0", () => {
    expect(() => releaseKindFromLegacy(0)).toThrow(/ReleaseType 0/);
    expect(() => releaseKindFromLegacy(6)).toThrow();
  });

  it("maps LCIDs", () => {
    expect(LANGUAGE_BY_LCID[4105]).toBe("en");
    expect(LANGUAGE_BY_LCID[3084]).toBe("fr");
  });

  // Legacy: Gcpe.Hub.Data_Legacy/Entity/PublishOptions.cs:17-19
  it("reads PublishOptions bit flags", () => {
    expect(hasPublishOption(3, PUBLISH_OPTIONS.NewsOnDemand)).toBe(true);
    expect(hasPublishOption(5, PUBLISH_OPTIONS.NewsOnDemand)).toBe(false);
    expect(hasPublishOption(5, PUBLISH_OPTIONS.MediaContacts)).toBe(true);
  });
});

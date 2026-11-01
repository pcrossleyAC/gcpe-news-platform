import { describe, expect, it } from "vitest";
import { canReplace } from "./replacement";
import { eventDataSchemas } from "./catalogue";

// Suite review fix round 2, M4 (controller ruling 2026-11-01): only a newer event that can stand in
// for an older one replaces it.
describe("canReplace", () => {
  it.each([
    ["release.published", "release.published", true],
    ["release.published", "release.unpublished", true],
    // NoD's release.updated only refreshes an item it already has: it can't stand in for the publish.
    ["release.published", "release.updated", false],
    ["release.published", "release.status_changed", false],
    ["release.updated", "release.updated", true],
    ["release.updated", "release.published", true],
    ["release.updated", "release.unpublished", true],
    ["release.unpublished", "release.published", true],
    ["release.unpublished", "release.updated", false],
    ["release.status_changed", "release.status_changed", true],
    ["org.upserted", "org.deactivated", true],
    ["org.deactivated", "org.upserted", true],
    ["org.succeeded", "org.upserted", false],
    ["org.upserted", "org.succeeded", false],
    ["sector.upserted", "sector.deactivated", true],
    ["sector.upserted", "theme.upserted", false],
    ["media_list.created", "media_list.updated", true],
    ["activity.created", "activity.deleted", true],
    ["activity.deleted", "activity.updated", true],
    ["delivery.bounced", "delivery.bounced", false],
    ["site.rebuild_requested", "site.rebuild_requested", false],
    ["government_terms.published", "government_terms.published", true],
  ])("%s is replaced by a newer %s: %s", (older, newer, expected) => {
    expect(canReplace(older, newer)).toBe(expected);
  });

  it("names every catalogue type it knows in some rule, and an unknown type replaces only nothing", () => {
    expect(canReplace("something.new", "something.new")).toBe(false);
    for (const type of Object.keys(eventDataSchemas)) expect(typeof canReplace(type, type)).toBe("boolean");
  });
});

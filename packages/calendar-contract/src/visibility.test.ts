import { describe, expect, it } from "vitest";
import { isOwnMinistry, visible, type Viewer, type VisibilityFacts } from "./visibility";

// The full role × HQ × own/shared/other × confidential × deleted matrix, and its agreement with
// the SQL form, is apps/calendar/src/visibility.test.ts. These pin that the rule NRMS now imports
// is the Calendar's own.
const live: VisibilityFacts = { contactMinistryKey: "health", sharedMinistryKeys: ["finance"], isConfidential: false, isDeleted: false };
const as = (over: Partial<Viewer>): Viewer => ({ level: 1, isHq: false, ministryKeys: [], ...over });

describe("visible() (spec addendum §6), shared by the Calendar and NRMS", () => {
  it("needs a Calendar role", () => {
    expect(visible(as({ level: 0, isHq: true }), live)).toBe(false);
  });

  it("a ministry user sees their own and shared ministries' activities, not another's", () => {
    expect(visible(as({ ministryKeys: ["health"] }), live)).toBe(true);
    expect(visible(as({ ministryKeys: ["finance"] }), live)).toBe(true);
    expect(visible(as({ ministryKeys: ["education"] }), live)).toBe(false);
  });

  it("HQ sees every ministry's; confidential needs HQ Advanced or the ministry itself", () => {
    expect(visible(as({ isHq: true }), live)).toBe(true);
    expect(visible(as({ isHq: true, level: 2 }), { ...live, isConfidential: true })).toBe(false);
    expect(visible(as({ isHq: true, level: 3 }), { ...live, isConfidential: true })).toBe(true);
    expect(visible(as({ ministryKeys: ["health"] }), { ...live, isConfidential: true })).toBe(true);
  });

  it("keys compare byte for byte", () => {
    expect(isOwnMinistry(as({ ministryKeys: ["Health"] }), "health")).toBe(false);
  });
});

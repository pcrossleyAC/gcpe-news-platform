import { describe, expect, it } from "vitest";
import { can, isOwnMinistry, ownsContactMinistry } from "./capabilities";
import type { VisibilityFacts } from "./visibility";

const own: VisibilityFacts = { contactMinistryKey: "health", sharedMinistryKeys: [], isConfidential: false, isDeleted: false };
const shared: VisibilityFacts = { contactMinistryKey: "finance", sharedMinistryKeys: ["health"], isConfidential: false, isDeleted: false };
const other: VisibilityFacts = { contactMinistryKey: "finance", sharedMinistryKeys: [], isConfidential: false, isDeleted: false };
const u = (level: number, isHq = false) => ({ level, isHq, ministryKeys: ["health"] });
const rules = { showHqCommentsField: false };

describe("the capability table (spec addendum §6)", () => {
  it("create: Editor and above, in their ministries; HQ in any", () => {
    expect(can.create(u(1), "health")).toBe(false);
    expect(can.create(u(2), "health")).toBe(true);
    expect(can.create(u(5), "finance")).toBe(false);
    expect(can.create(u(2, true), "finance")).toBe(true);
  });
  it("edit and clone: Editor and above, contact ministry theirs or HQ; shared-with ministries only view", () => {
    expect(can.edit(u(2), own)).toBe(true);
    expect(can.edit(u(5), shared)).toBe(false);
    expect(can.clone(u(5), shared)).toBe(false);
    expect(can.edit(u(2, true), other)).toBe(true);
    expect(can.edit(u(1, true), other)).toBe(false);
    expect(can.edit(u(5, true), { ...own, isDeleted: true })).toBe(false);
  });
  it("edit needs visibility: an HQ Editor can't edit another ministry's confidential activity", () => {
    expect(can.edit(u(2, true), { ...other, isConfidential: true })).toBe(false);
    expect(can.edit(u(3, true), { ...other, isConfidential: true })).toBe(true);
  });
  it("delete: Administrator with edit rights", () => {
    expect(can.delete(u(3), own)).toBe(false);
    expect(can.delete(u(4), own)).toBe(true);
    expect(can.delete(u(4), other)).toBe(false);
  });
  it("review: HQ Advanced; review selected: HQ Administrator; Clear LA Status: HQ Editor", () => {
    expect(can.review(u(5), own)).toBe(false);
    expect(can.review(u(2, true), own)).toBe(false);
    expect(can.review(u(3, true), own)).toBe(true);
    expect(can.reviewSelected(u(3, true))).toBe(false);
    expect(can.reviewSelected(u(4, true))).toBe(true);
    expect(can.clearLaStatus(u(5))).toBe(false);
    expect(can.clearLaStatus(u(2, true))).toBe(true);
  });
  it("the Look Ahead fieldset: HQ Editor, or anyone with edit rights when ShowHqCommentsField is on", () => {
    expect(can.seeLookAheadFieldset(u(2, true), rules)).toBe(true);
    expect(can.seeLookAheadFieldset(u(1, true), rules)).toBe(false);
    expect(can.seeLookAheadFieldset(u(5), rules)).toBe(false);
    expect(can.seeLookAheadFieldset(u(2), { showHqCommentsField: true }, own)).toBe(true);
    expect(can.seeLookAheadFieldset(u(2), { showHqCommentsField: true }, other)).toBe(false);
  });
  it("HQ privileges at Editor and above: freeze exemption, relaxed fields, HQ Placeholder, review markup", () => {
    for (const f of [can.skipFreeze, can.relaxRequiredFields, can.useHqPlaceholder, can.seeNeedsReviewMarkup]) {
      expect(f(u(2, true))).toBe(true);
      expect(f(u(1, true))).toBe(false);
      expect(f(u(5))).toBe(false);
    }
  });
  it("Transfer: Administrator and above", () => {
    expect(can.transfer(u(3))).toBe(false);
    expect(can.transfer(u(4))).toBe(true);
  });
  it("ministry ownership is byte-exact, and a shared-with ministry doesn't own the activity", () => {
    expect(isOwnMinistry(u(2), "health")).toBe(true);
    expect(isOwnMinistry(u(2), "Health")).toBe(false);
    expect(can.create(u(2), "HEALTH")).toBe(false);
    expect(ownsContactMinistry(u(2), own)).toBe(true);
    expect(ownsContactMinistry(u(2), shared)).toBe(false);
    expect(ownsContactMinistry(u(2), { ...own, contactMinistryKey: null })).toBe(false);
  });
});

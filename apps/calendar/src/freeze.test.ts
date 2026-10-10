import { describe, expect, it } from "vitest";
import { TEST_RULES } from "../test/helpers";
import { assertNotFrozen, FreezeError, freezeStateAt } from "./freeze";

const editor = { level: 2, isHq: false, ministryKeys: ["health"] };
const hqEditor = { level: 2, isHq: true, ministryKeys: ["gcpe-hq"] };
const hqReadOnly = { level: 1, isHq: true, ministryKeys: ["gcpe-hq"] };
const at = (iso: string) => new Date(iso);

// Instants either side of every boundary, on 2026-10-31 (PDT), on 2026-11-01 and 2026-11-02
// (BC's first days of permanent UTC−7), and in mid-winter and mid-summer 2027.
const CASES: [string, boolean][] = [
  ["2026-10-31T22:59:59Z", false], // 15:59:59
  ["2026-10-31T23:00:00Z", true], //  16:00:00
  ["2026-10-31T23:59:59Z", true], //  16:59:59
  ["2026-11-01T00:00:00Z", false], // 17:00:00
  ["2026-11-01T22:59:59Z", false],
  ["2026-11-01T23:00:00Z", true], //  old tzdata reads 15:00 PST here
  ["2026-11-02T22:59:59Z", false],
  ["2026-11-02T23:00:00Z", true],
  ["2026-11-02T23:59:59Z", true],
  ["2026-11-03T00:00:00Z", false],
  ["2027-01-15T23:30:00Z", true],
  ["2027-07-15T23:30:00Z", true],
];

describe("the change freeze in BC time (spec addendum §7.4)", () => {
  it.each(CASES)("at %s a non-exempt user is frozen: %s", (iso, frozen) => {
    expect(freezeStateAt(at(iso), editor, TEST_RULES).active).toBe(frozen);
    if (frozen) expect(() => assertNotFrozen(at(iso), editor, TEST_RULES)).toThrow(FreezeError);
    else expect(() => assertNotFrozen(at(iso), editor, TEST_RULES)).not.toThrow();
  });

  it("an HQ Editor is exempt; HQ Read Only is not", () => {
    expect(() => assertNotFrozen(at("2026-11-02T23:30:00Z"), hqEditor, TEST_RULES)).not.toThrow();
    expect(freezeStateAt(at("2026-11-02T23:30:00Z"), hqEditor, TEST_RULES)).toMatchObject({ active: true, appliesToYou: false });
    expect(() => assertNotFrozen(at("2026-11-02T23:30:00Z"), hqReadOnly, TEST_RULES)).toThrow(FreezeError);
  });

  it("uses the configured window and says so", () => {
    const rules = { ...TEST_RULES, freeze: { start: "09:00", end: "09:30" } };
    expect(freezeStateAt(at("2026-11-02T16:15:00Z"), editor, rules)).toMatchObject({ active: true, start: "09:00", end: "09:30", message: expect.stringContaining("9am-9:30am") });
    expect(() => assertNotFrozen(at("2026-11-02T16:15:00Z"), editor, rules)).toThrow("You cannot make content changes between 9am-9:30am.");
  });
});

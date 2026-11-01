import { afterEach, describe, expect, it } from "vitest";
import { formatInZone, offsetMinutesAt, setServerZoneRule, wallClockToInstant, zonedDate, zonedDateTime } from "./bcTime";
import { BC_RULE, playOldRulesBrowser } from "./oldRulesBrowser.testkit";

const BC = "America/Vancouver";
const time = (iso: string) => formatInZone(iso, BC, { hour: "numeric", minute: "2-digit", hour12: true }).replace(/\s/g, " ");
const wall = (local: string) => wallClockToInstant(new Date(`${local}:00.000Z`), BC).toISOString();

let undo: (() => void) | null = null;
afterEach(() => {
  undo?.();
  undo = null;
  setServerZoneRule(null);
});

describe("an old-rules browser, before the Hub corrects it (the bug)", () => {
  it("shows a 09:00 go-live after 2026-11-01 as 8:00 AM and puts 00:30 Nov 2 on Nov 1", () => {
    undo = playOldRulesBrowser();
    expect(time("2026-11-03T16:00:00Z")).toBe("8:00 AM");
    expect(zonedDate("2026-11-02T07:30:00Z", BC)).toBe("2026-11-01");
    expect(wall("2026-11-03T09:00")).toBe("2026-11-03T17:00:00.000Z");
  });
});

describe("an old-rules browser, corrected by the server's rule", () => {
  it("shows 2026-11-03 16:00Z as 9:00 AM (permanent UTC-7)", () => {
    undo = playOldRulesBrowser();
    setServerZoneRule(BC_RULE);
    expect(time("2026-11-03T16:00:00Z")).toBe("9:00 AM");
    expect(formatInZone("2026-11-03T16:00:00Z", BC, { weekday: "long", month: "short", day: "numeric", year: "numeric" })).toBe("Tuesday, Nov 3, 2026");
  });

  it("keeps the past right: 2026-01-15 17:00Z is 9:00 AM (winter, UTC-8) and 2026-07-15 16:00Z is 9:00 AM (summer, UTC-7)", () => {
    undo = playOldRulesBrowser();
    setServerZoneRule(BC_RULE);
    expect(time("2026-01-15T17:00:00Z")).toBe("9:00 AM");
    expect(time("2026-07-15T16:00:00Z")).toBe("9:00 AM");
    expect(time("2025-11-02T09:30:00Z")).toBe("1:30 AM"); // the last real fall-back: PST
    expect(offsetMinutesAt(Date.parse("2026-01-15T17:00:00Z"), BC)).toBe(-480);
  });

  it("puts instants around midnight on the right BC day", () => {
    undo = playOldRulesBrowser();
    setServerZoneRule(BC_RULE);
    expect(zonedDate("2026-11-01T06:30:00Z", BC)).toBe("2026-10-31");
    expect(zonedDateTime("2026-11-01T07:30:00Z", BC)).toEqual({ date: "2026-11-01", time: "00:30" });
    expect(zonedDateTime("2026-11-01T09:30:00Z", BC)).toEqual({ date: "2026-11-01", time: "02:30" }); // no repeated hour any more
    expect(zonedDateTime("2026-11-02T07:30:00Z", BC)).toEqual({ date: "2026-11-02", time: "00:30" });
    expect(zonedDate("2026-12-31T23:30:00Z", BC)).toBe("2026-12-31");
    expect(zonedDate("2027-01-01T07:00:00Z", BC)).toBe("2027-01-01");
  });

  it("turns BC wall-clock back into the right instant, both sides of the change", () => {
    undo = playOldRulesBrowser();
    setServerZoneRule(BC_RULE);
    expect(wall("2026-11-03T09:00")).toBe("2026-11-03T16:00:00.000Z");
    expect(wall("2026-11-01T01:30")).toBe("2026-11-01T08:30:00.000Z");
    expect(wall("2026-01-15T09:00")).toBe("2026-01-15T17:00:00.000Z");
    expect(wall("2026-03-08T02:30")).toBe("2026-03-08T10:30:00.000Z"); // spring-forward gap
    expect(offsetMinutesAt(Date.parse("2027-01-15T19:00:00Z"), BC)).toBe(-420);
  });

  it("leaves other zones alone", () => {
    undo = playOldRulesBrowser();
    setServerZoneRule(BC_RULE);
    expect(formatInZone("2026-11-03T16:00:00Z", "UTC", { hour: "numeric", minute: "2-digit", hourCycle: "h23" })).toBe("16:00");
    expect(formatInZone("2026-11-03T16:00:00Z", "America/Toronto", { hour: "numeric", minute: "2-digit", hourCycle: "h23" })).toBe("11:00");
  });
});

describe("an up-to-date browser", () => {
  it("is unchanged, with or without the rule", () => {
    for (const withRule of [false, true]) {
      setServerZoneRule(withRule ? BC_RULE : null);
      expect(time("2026-11-03T16:00:00Z")).toBe("9:00 AM");
      expect(time("2026-01-15T17:00:00Z")).toBe("9:00 AM");
      expect(time("2026-07-15T16:00:00Z")).toBe("9:00 AM");
      expect(zonedDate("2026-11-01T06:30:00Z", BC)).toBe("2026-10-31");
      expect(zonedDate("2026-11-02T07:30:00Z", BC)).toBe("2026-11-02");
      expect(wall("2026-11-03T09:00")).toBe("2026-11-03T16:00:00.000Z");
    }
  });
});

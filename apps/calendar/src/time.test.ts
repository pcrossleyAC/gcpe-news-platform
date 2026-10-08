import { describe, expect, it } from "vitest";
import { addDays, bcMidnight, instantOf, wallClock } from "./time";

const BC = "America/Vancouver";

describe("BC wall-clock time (Node 24's tzdata; spec addendum §7.4)", () => {
  it("BC is UTC−7 on both sides of 2026-11-01: the clocks don't fall back", () => {
    // With tzdata older than 2026b this reads 15:00 (PST): run the suite under Node 24.
    expect(wallClock(new Date("2026-11-02T23:00:00Z"), BC)).toEqual({ date: "2026-11-02", time: "16:00", secondsOfDay: 16 * 3600 });
    expect(wallClock(new Date("2026-10-31T23:00:00Z"), BC).time).toBe("16:00");
    expect(wallClock(new Date("2026-11-01T09:30:00Z"), BC).time).toBe("02:30");
    expect(wallClock(new Date("2027-07-15T23:00:00Z"), BC).time).toBe("16:00");
  });
  it("converts a BC date and time to the instant, and back", () => {
    expect(instantOf("2026-11-01", "00:00", BC).toISOString()).toBe("2026-11-01T07:00:00.000Z");
    expect(instantOf("2026-11-01", "23:45", BC).toISOString()).toBe("2026-11-02T06:45:00.000Z");
    expect(instantOf("2026-03-08", "02:30", BC).toISOString()).toBe("2026-03-08T10:30:00.000Z");
  });
  it("adds days to a date and finds BC midnight", () => {
    expect(addDays("2026-10-31", 2)).toBe("2026-11-02");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(bcMidnight("2026-11-02", BC).toISOString()).toBe("2026-11-02T07:00:00.000Z");
  });
});

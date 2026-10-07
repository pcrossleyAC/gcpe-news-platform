import { describe, expect, it } from "vitest";
import { addDays, dayBounds, localDate, localDateTime, MAX_RANGE_DAYS, ReportRangeError, resolveRange } from "./range";

const BC = "America/Vancouver";
const iso = (ds: Date[]) => ds.map((d) => d.toISOString());

describe("dayBounds", () => {
  it("keeps BC midnight at 07:00Z across 2026-11-01 (BC stays on UTC−7; needs tzdata 2026b+)", () => {
    expect(iso(dayBounds("2026-10-31", 3, BC))).toEqual([
      "2026-10-31T07:00:00.000Z",
      "2026-11-01T07:00:00.000Z",
      "2026-11-02T07:00:00.000Z",
      "2026-11-03T07:00:00.000Z",
    ]);
  });

  it("moves BC midnight from 08:00Z to 07:00Z across the March 2026 clock change", () => {
    expect(iso(dayBounds("2026-03-07", 2, BC))).toEqual(["2026-03-07T08:00:00.000Z", "2026-03-08T08:00:00.000Z", "2026-03-09T07:00:00.000Z"]);
  });
});

describe("local formatting", () => {
  it("formats instants as BC dates and times", () => {
    expect(localDate(new Date("2026-11-01T06:30:00Z"), BC)).toBe("2026-10-31");
    expect(localDateTime(new Date("2026-11-15T20:05:00Z"), BC)).toBe("2026-11-15 13:05");
    expect(localDateTime(new Date("2026-07-01T07:00:00Z"), BC)).toBe("2026-07-01 00:00");
  });
});

describe("resolveRange", () => {
  it("defaults to the 30 days ending today", () => {
    const r = resolveRange({}, "2026-10-07", BC);
    expect(r).toMatchObject({ from: "2026-09-08", to: "2026-10-07", days: 30 });
    expect(r.start.toISOString()).toBe("2026-09-08T07:00:00.000Z");
    expect(r.end.toISOString()).toBe("2026-10-08T07:00:00.000Z");
    expect(r.bounds).toHaveLength(31);
  });

  it("accepts a range up to the maximum and refuses one day more", () => {
    expect(resolveRange({ from: "2026-01-01", to: addDays("2026-01-01", MAX_RANGE_DAYS - 1) }, "2026-10-07", BC).days).toBe(92);
    expect(() => resolveRange({ from: "2026-01-01", to: addDays("2026-01-01", MAX_RANGE_DAYS) }, "2026-10-07", BC)).toThrow(
      expect.objectContaining({ code: "range-too-long" }),
    );
  });

  it("refuses reversed ranges and dates that don't exist", () => {
    expect(() => resolveRange({ from: "2026-10-07", to: "2026-10-06" }, "2026-10-07", BC)).toThrow(expect.objectContaining({ code: "range-reversed" }));
    expect(() => resolveRange({ from: "2026-02-30" }, "2026-10-07", BC)).toThrow(ReportRangeError);
    expect(() => resolveRange({ to: "07/10/2026" }, "2026-10-07", BC)).toThrow(expect.objectContaining({ code: "invalid-date" }));
  });
});

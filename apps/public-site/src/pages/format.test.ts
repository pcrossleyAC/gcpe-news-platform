import { describe, expect, it } from "vitest";
import { bytesReadable, displayDateTime, displayDateTimeNoWeekday } from "./format";

describe("displayDateTime", () => {
  it("displayDateTime('2026-09-22T11:45:00-07:00') is 'Tuesday, September 22, 2026 11:45 AM'; T00:05 is 12:05 AM; T12:00 is 12:00 PM", () => {
    expect(displayDateTime("2026-09-22T11:45:00-07:00")).toBe("Tuesday, September 22, 2026 11:45 AM");
    expect(displayDateTime("2026-09-22T00:05:00-07:00")).toBe("Tuesday, September 22, 2026 12:05 AM");
    expect(displayDateTime("2026-09-22T12:00:00-07:00")).toBe("Tuesday, September 22, 2026 12:00 PM");
    expect(displayDateTime("2026-09-22T23:59:00-07:00")).toBe("Tuesday, September 22, 2026 11:59 PM");
  });

  it("reads the wall clock as written, whatever the offset (no time-zone maths)", () => {
    // After 2026-11-01 BC stays on UTC−7 all year; the News API writes the BC-local wall clock either way.
    expect(displayDateTime("2026-12-01T09:30:00-07:00")).toBe("Tuesday, December 1, 2026 9:30 AM");
    expect(displayDateTime("2026-01-05T09:30:00-08:00")).toBe("Monday, January 5, 2026 9:30 AM");
    expect(displayDateTime("2024-02-29T16:00:00Z")).toBe("Thursday, February 29, 2024 4:00 PM");
  });

  it("the 2026-11-01 boundary (BC on UTC−7 all year from then): the same wall clock either side reads as written, with the right weekday", () => {
    expect(displayDateTime("2026-10-31T10:15:00-07:00")).toBe("Saturday, October 31, 2026 10:15 AM");
    expect(displayDateTime("2026-11-01T01:30:00-07:00")).toBe("Sunday, November 1, 2026 1:30 AM");
    expect(displayDateTime("2026-11-01T02:30:00-07:00")).toBe("Sunday, November 1, 2026 2:30 AM");
    expect(displayDateTime("2026-11-02T10:15:00-07:00")).toBe("Monday, November 2, 2026 10:15 AM");
  });

  it("returns an impossible calendar date or clock as is (no rolled-over weekday)", () => {
    for (const bad of ["2026-02-29T10:00:00-08:00", "2026-02-31T10:00:00-08:00", "2026-04-31T10:00:00-07:00", "2026-13-01T10:00:00-07:00", "2026-00-10T10:00:00-07:00", "2026-09-00T10:00:00-07:00", "2026-09-22T24:00:00-07:00", "2026-09-22T11:60:00-07:00", "2026-09-22T11:99:00-07:00"]) {
      expect(displayDateTime(bad), bad).toBe(bad);
    }
    expect(displayDateTime("2028-02-29T10:00:00-07:00")).toBe("Tuesday, February 29, 2028 10:00 AM");
  });

  it("returns an unparseable string as is", () => {
    expect(displayDateTime("not a date")).toBe("not a date");
    expect(displayDateTime("2026-09-22")).toBe("2026-09-22");
    expect(displayDateTime("")).toBe("");
  });
});

describe("bytesReadable", () => {
  it("bytesReadable: 500 → '1 KB'; 1536 → '2 KB'; 5_000_000 → '4,883 KB'", () => {
    expect(bytesReadable(500)).toBe("1 KB");
    expect(bytesReadable(1536)).toBe("2 KB");
    expect(bytesReadable(5_000_000)).toBe("4,883 KB");
  });

  it("0 and 1023 are '1 KB'; 1024 is '1 KB'; 1_048_576 is '1,024 KB'", () => {
    expect(bytesReadable(0)).toBe("1 KB");
    expect(bytesReadable(1023)).toBe("1 KB");
    expect(bytesReadable(1024)).toBe("1 KB");
    expect(bytesReadable(1_048_576)).toBe("1,024 KB");
  });
});

describe("displayDateTimeNoWeekday (legacy FormatDate, MMMM d, yyyy h:mm tt)", () => {
  it("writes the BC wall clock without a weekday; a malformed date is returned as is", () => {
    expect(displayDateTimeNoWeekday("2026-09-21T10:15:00-07:00")).toBe("September 21, 2026 10:15 AM");
    expect(displayDateTimeNoWeekday("2026-09-21T00:05:00-07:00")).toBe("September 21, 2026 12:05 AM");
    expect(displayDateTimeNoWeekday("2026-02-30T10:00:00-08:00")).toBe("2026-02-30T10:00:00-08:00");
    expect(displayDateTimeNoWeekday("soon")).toBe("soon");
  });
});

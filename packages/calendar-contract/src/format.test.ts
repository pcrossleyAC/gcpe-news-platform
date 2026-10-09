import { describe, expect, it } from "vitest";
import { friendlyDateRange, friendlySpan } from "./format";

const tz = "America/Vancouver";
// BC is UTC−7 from 2026-11-01, so 09:00 BC is 16:00Z.
const at = (iso: string) => new Date(iso);
const o = { timeZone: tz, today: "2026-11-03" };

describe("friendlyDateRange (ActivityListProvider.ashx.cs:769-840)", () => {
  const timed = (start: string, end: string, more: object = {}) => ({ startAt: at(start), endAt: at(end), isAllDay: false, isConfirmed: true, ...more });
  it("one timed day: weekday, month, day, and the times with AM/PM once when both share it", () => {
    expect(friendlyDateRange(timed("2026-11-10T16:00:00Z", "2026-11-10T17:00:00Z"), o)).toBe("Tue Nov 10 9:00-10:00 AM");
    expect(friendlyDateRange(timed("2026-11-10T18:00:00Z", "2026-11-10T20:00:00Z"), o)).toBe("Tue Nov 10 11:00 AM-1:00 PM");
  });
  it("all day: the date alone; another year shows the year", () => {
    expect(friendlyDateRange({ ...timed("2026-11-10T07:00:00Z", "2026-11-11T06:45:00Z"), isAllDay: true }, o)).toBe("Tue Nov 10");
    expect(friendlyDateRange(timed("2027-01-06T16:00:00Z", "2027-01-06T17:00:00Z"), o)).toBe("Wed Jan 6 2027 9:00-10:00 AM");
  });
  it("several days: no weekday, the month once when it doesn't change, years when they differ", () => {
    expect(friendlyDateRange(timed("2026-11-10T16:00:00Z", "2026-11-12T17:00:00Z"), o)).toBe("Nov 10-12");
    expect(friendlyDateRange(timed("2026-11-30T16:00:00Z", "2026-12-02T17:00:00Z"), o)).toBe("Nov 30-Dec 2");
    expect(friendlyDateRange(timed("2026-12-30T16:00:00Z", "2027-01-02T17:00:00Z"), o)).toBe("Dec 30 2026-Jan 2 2027");
  });
  it("unconfirmed: TBC, Time TBD for legacy's 8 AM to 6 PM placeholder, Potential Dates in place of the dates", () => {
    expect(friendlyDateRange(timed("2026-11-10T16:00:00Z", "2026-11-10T17:00:00Z", { isConfirmed: false }), o)).toBe("Tue Nov 10 9:00-10:00 AM TBC");
    expect(friendlyDateRange(timed("2026-11-10T15:00:00Z", "2026-11-11T01:00:00Z", { isConfirmed: false }), o)).toBe("Tue Nov 10 Time TBD");
    expect(friendlyDateRange(timed("2026-11-10T16:00:00Z", "2026-11-10T17:00:00Z", { isConfirmed: false, potentialDates: "Late November" }), o)).toBe("Late November TBC");
  });
  it("no dates: the Potential Dates, or a dash", () => {
    expect(friendlyDateRange({ startAt: null, endAt: null, isAllDay: false, isConfirmed: false, potentialDates: "Spring" }, o)).toBe("Spring");
    expect(friendlyDateRange({ startAt: null, endAt: null, isAllDay: false, isConfirmed: false }, o)).toBe("—");
  });
});

describe("friendlySpan (ActivityListProvider.ashx.cs:850-876)", () => {
  const now = at("2026-11-03T18:00:00Z");
  it("months, weeks, days, then hours or minutes the same day", () => {
    expect(friendlySpan(at("2026-09-01T18:00:00Z"), now, tz)).toBe("2 Months");
    expect(friendlySpan(at("2026-10-20T18:00:00Z"), now, tz)).toBe("2 Weeks");
    expect(friendlySpan(at("2026-11-01T18:00:00Z"), now, tz)).toBe("2 Days");
    expect(friendlySpan(at("2026-11-03T15:00:00Z"), now, tz)).toBe("3 Hours");
    expect(friendlySpan(at("2026-11-03T17:59:00Z"), now, tz)).toBe("1 Minute");
  });
});

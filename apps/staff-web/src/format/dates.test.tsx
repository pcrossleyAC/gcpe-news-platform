import { describe, expect, it } from "vitest";
import { formatWhen, relativeDay } from "./dates";

// America/Vancouver: standard time (PST, UTC-8) until 2026-03-08's spring-forward, daylight
// time (PDT, UTC-7) from then until 2026-11-01's switch to *permanent* UTC-7 (tzdata 2026c —
// see project memory: "BC permanent UTC-7 from 2026-11-01; need tzdata >=2026b (Node 24)").
// 2025-11-02 is the last ordinary fall-back before that law takes effect. Every expected value
// below was cross-checked against `Intl.DateTimeFormat`'s own wall-clock output for the given
// instant in this zone (not hand-computed), so the fixture itself can't be the source of a
// wrong expectation.
const TZ = "America/Vancouver";

describe("relativeDay (constraints.md wording, BC time zone)", () => {
  it("is Today for the same BC calendar day", () => {
    const now = new Date("2026-06-15T18:00:00Z"); // 2026-06-15 11:00 PDT
    expect(relativeDay("2026-06-15T15:00:00Z", now, TZ)).toBe("Today"); // 2026-06-15 08:00 PDT
  });

  it("is Yesterday for the BC calendar day before now", () => {
    const now = new Date("2026-06-15T18:00:00Z"); // 2026-06-15 11:00 PDT
    expect(relativeDay("2026-06-14T18:00:00Z", now, TZ)).toBe("Yesterday"); // 2026-06-14 11:00 PDT
  });

  it("is Tomorrow for the BC calendar day after now", () => {
    const now = new Date("2026-06-15T18:00:00Z"); // 2026-06-15 11:00 PDT
    expect(relativeDay("2026-06-16T18:00:00Z", now, TZ)).toBe("Tomorrow"); // 2026-06-16 11:00 PDT
  });

  it("is the weekday name 2..6 BC calendar days away", () => {
    // 2026-06-15 is a Monday in BC.
    const now = new Date("2026-06-15T18:00:00Z"); // Monday, 11:00 PDT
    expect(relativeDay("2026-06-17T18:00:00Z", now, TZ)).toBe("Wednesday"); // +2 days
    expect(relativeDay("2026-06-21T18:00:00Z", now, TZ)).toBe("Sunday"); // +6 days
    expect(relativeDay("2026-06-13T18:00:00Z", now, TZ)).toBe("Saturday"); // -2 days
    expect(relativeDay("2026-06-09T18:00:00Z", now, TZ)).toBe("Tuesday"); // -6 days
  });

  it("is MMM d, yyyy for 7+ BC calendar days away", () => {
    const now = new Date("2026-06-15T18:00:00Z");
    expect(relativeDay("2026-06-22T18:00:00Z", now, TZ)).toBe("Jun 22, 2026"); // +7 days
    expect(relativeDay("2026-01-02T18:00:00Z", now, TZ)).toBe("Jan 2, 2026"); // far in the past
  });

  it("uses the BC midnight boundary, not the UTC one", () => {
    // 2026-01-15 is standard time in BC (UTC-8): BC midnight on 2026-01-15 is 2026-01-15T08:00:00Z.
    const now = new Date("2026-01-15T20:00:00Z"); // 2026-01-15 12:00 PST — "now" is BC Jan 15.
    // 2026-01-15T07:59:00Z is 2026-01-14 23:59 PST — the BC calendar day *before* now, even
    // though its UTC date string ("2026-01-15") matches now's. A UTC-based implementation
    // would wrongly call this "Today".
    expect(relativeDay("2026-01-15T07:59:00Z", now, TZ)).toBe("Yesterday");
    // 2026-01-15T08:01:00Z is 2026-01-15 00:01 PST — the same BC calendar day as now.
    expect(relativeDay("2026-01-15T08:01:00Z", now, TZ)).toBe("Today");
  });

  it("is DST-safe across the 2026-03-08 spring-forward", () => {
    // 2026-03-08 02:00 local never happens (clocks jump 02:00 -> 03:00 PDT); the day is only
    // 23 real hours long. A millisecond-based day count (instead of comparing calendar Y-M-D)
    // would misclassify the day before/after this transition.
    const now = new Date("2026-03-09T17:00:00Z"); // 2026-03-09 10:00 PDT
    expect(relativeDay("2026-03-08T17:00:00Z", now, TZ)).toBe("Yesterday"); // 2026-03-08 09:00 PDT (spring-forward day)
    expect(relativeDay("2026-03-07T17:00:00Z", now, TZ)).toBe("Saturday"); // 2026-03-07 09:00 PST, 2 BC days back
  });

  it("is DST-safe across the 2025-11-02 fall-back", () => {
    // 2025-11-02 01:30 local happens twice (clocks fall back 02:00 -> 01:00 PST); the day is
    // 25 real hours long.
    const now = new Date("2025-11-03T17:00:00Z"); // 2025-11-03 09:00 PST
    expect(relativeDay("2025-11-02T17:00:00Z", now, TZ)).toBe("Yesterday"); // 2025-11-02 09:00 PST (fall-back day)
    expect(relativeDay("2025-11-01T17:00:00Z", now, TZ)).toBe("Saturday"); // 2025-11-01 10:00 PDT, 2 BC days back
  });

  it("is correct right at the 2026-11-01 switch to permanent UTC-7", () => {
    // From 2026-11-01 on, BC no longer observes DST (tzdata 2026c) — every instant is UTC-7,
    // including the weekend that would have been the fall-back under the old rules.
    const now = new Date("2026-11-02T17:00:00Z"); // 2026-11-02 10:00, UTC-7
    expect(relativeDay("2026-11-01T17:00:00Z", now, TZ)).toBe("Yesterday"); // 2026-11-01 10:00, UTC-7
    expect(relativeDay("2026-10-31T17:00:00Z", now, TZ)).toBe("Saturday"); // 2026-10-31 10:00, UTC-7 (still DST, pre-switch)
  });

  it("handles the New Year boundary", () => {
    const now = new Date("2026-01-01T20:00:00Z"); // 2026-01-01 12:00 PST
    expect(relativeDay("2025-12-31T20:00:00Z", now, TZ)).toBe("Yesterday");
    expect(relativeDay("2025-12-25T20:00:00Z", now, TZ)).toBe("Dec 25, 2025");
  });
});

describe('formatWhen (constraints.md: times as h:mm a, e.g. "Today 2:30 PM")', () => {
  it("combines the relative day wording with a h:mm a time", () => {
    const now = new Date("2026-06-15T18:00:00Z"); // 2026-06-15 11:00 PDT
    expect(formatWhen("2026-06-15T21:30:00Z", now, TZ)).toBe("Today 2:30 PM"); // 14:30 PDT
  });

  it("pads single-digit minutes and uses 12-hour wording", () => {
    const now = new Date("2026-06-15T18:00:00Z");
    expect(formatWhen("2026-06-15T16:05:00Z", now, TZ)).toBe("Today 9:05 AM"); // 09:05 PDT
  });

  it("uses the weekday/date forms from relativeDay for farther-out dates", () => {
    const now = new Date("2026-06-15T18:00:00Z");
    expect(formatWhen("2026-06-22T21:30:00Z", now, TZ)).toBe("Jun 22, 2026 2:30 PM");
  });
});

import { describe, expect, it } from "vitest";
import { offsetFixedSince, tzCheckFor, utcOffsetMinutes, wallClockToInstant } from "./timezone";

const TZ = "America/Vancouver";

// Fix round 1, minor 4: pin the three controller-specified DST/offset dates here, rather than
// only in whichever client-side conversion function happens to remain — this is now the one
// canonical implementation (apps/nrms and apps/staff-web both derive from or mirror this).
describe("wallClockToInstant", () => {
  it("2026-03-08 02:30 BC local (spring-forward gap, shifts into PDT) -> 2026-03-08T10:30:00.000Z", () => {
    const d = new Date("2026-03-08T02:30:00.000Z"); // UTC fields hold the wall-clock value
    expect(wallClockToInstant(d, TZ).toISOString()).toBe("2026-03-08T10:30:00.000Z");
  });

  it("2025-11-02 01:30 BC local (fall-back ambiguous hour, picks the earlier PDT instant) -> 2025-11-02T08:30:00.000Z", () => {
    const d = new Date("2025-11-02T01:30:00.000Z");
    expect(wallClockToInstant(d, TZ).toISOString()).toBe("2025-11-02T08:30:00.000Z");
  });

  it("2026-12-15 14:30 BC local, after BC's permanent UTC-7 switch (2026-11-01) -> 2026-12-15T21:30:00.000Z (requires Node 24+ tzdata)", () => {
    const d = new Date("2026-12-15T14:30:00.000Z");
    expect(wallClockToInstant(d, TZ).toISOString()).toBe("2026-12-15T21:30:00.000Z");
  });

  it("converts an ordinary PST wall-clock time (no DST ambiguity) to its real UTC instant", () => {
    const d = new Date("2024-02-01T09:00:00.000Z");
    expect(wallClockToInstant(d, TZ).toISOString()).toBe("2024-02-01T17:00:00.000Z");
  });
});

describe("utcOffsetMinutes", () => {
  it("UTC is always zero", () => {
    expect(utcOffsetMinutes("2024-06-01T12:00:00Z", "UTC")).toBe(0);
  });

  it("America/Vancouver in summer (PDT, UTC-7) is -420", () => {
    expect(utcOffsetMinutes("2024-06-01T12:00:00Z", TZ)).toBe(-420);
  });

  it("America/Vancouver in winter, before BC's permanent-DST switch (PST, UTC-8) is -480", () => {
    expect(utcOffsetMinutes("2024-01-15T12:00:00Z", TZ)).toBe(-480);
  });

  it("America/Vancouver after BC's permanent UTC-7 switch (2026-11-01) stays -420 even in December (requires Node 24+ tzdata)", () => {
    expect(utcOffsetMinutes("2026-12-15T20:00:00Z", TZ)).toBe(-420);
  });
});

// BC's change (2026-10-31 owner decision): the server tells the Hub since when the zone has kept
// one fixed offset, so a browser whose tzdata predates the change can be corrected — by the
// server's own rules, never a second hand-written copy of them.
describe("offsetFixedSince", () => {
  it("Vancouver: UTC-7 since the 2026-03-08 spring-forward, and for good (requires Node 24+ tzdata)", () => {
    // 2026-03-08 02:00 PST is 10:00Z; from then on it is UTC-7 (PDT, then permanent MST from 2026-11-01).
    expect(offsetFixedSince(TZ)).toBe("2026-03-08T10:00:00.000Z");
    expect(utcOffsetMinutes("2026-03-08T09:59:59Z", TZ)).toBe(-480);
  });

  it("a zone that still changes its clocks has no fixed offset", () => {
    expect(offsetFixedSince("America/Toronto")).toBeNull();
    expect(offsetFixedSince("Europe/London")).toBeNull();
  });

  it("a zone that has not changed within the look-back gives the earliest instant it checked, which is still true", () => {
    const since = offsetFixedSince("UTC");
    expect(since).not.toBeNull();
    expect(Date.parse(since!)).toBeLessThan(Date.parse("2017-01-01T00:00:00Z"));
  });

  it("tzCheckFor carries it beside the pinned instant and offset", () => {
    expect(tzCheckFor(TZ)).toEqual({ at: "2026-12-15T20:00:00Z", offsetMinutes: -420, fixedSince: "2026-03-08T10:00:00.000Z" });
    expect(tzCheckFor("America/Toronto").fixedSince).toBeNull();
  });
});

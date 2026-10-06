import { describe, expect, it } from "vitest";
import { utcOffsetMinutes, wallClockToInstant } from "./timezone";

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

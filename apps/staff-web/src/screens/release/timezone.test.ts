import { describe, expect, it } from "vitest";
import { bcLocalToInstant, instantToBcLocal, wallClockToInstant } from "./timezone";

const TZ = "America/Vancouver";

describe("wallClockToInstant (ported from packages/legacy-import/src/timezone.ts)", () => {
  it("converts an ordinary PDT wall-clock time (no DST ambiguity) to its real UTC instant", () => {
    const d = new Date("2024-06-01T11:52:00.000Z");
    expect(wallClockToInstant(d, TZ).toISOString()).toBe("2024-06-01T18:52:00.000Z");
  });

  it("converts an ordinary PST wall-clock time (no DST ambiguity) to its real UTC instant", () => {
    const d = new Date("2024-02-01T09:00:00.000Z");
    expect(wallClockToInstant(d, TZ).toISOString()).toBe("2024-02-01T17:00:00.000Z");
  });

  it("fall-back (2024-11-03 2am PDT -> 1am PST): the ambiguous hour resolves to the earlier, PDT instant", () => {
    const d = new Date("2024-11-03T01:30:00.000Z");
    expect(wallClockToInstant(d, TZ).toISOString()).toBe("2024-11-03T08:30:00.000Z");
  });

  it("spring-forward (2024-03-10 2am PST -> 3am PDT): the skipped hour shifts forward", () => {
    const d = new Date("2024-03-10T02:30:00.000Z");
    expect(wallClockToInstant(d, TZ).toISOString()).toBe("2024-03-10T10:30:00.000Z");
  });

  // Fix round 1 (3f Task 3), minor 4: the controller's three pinned DST/offset dates, also
  // pinned in packages/config/src/timezone.test.ts (the canonical server-side implementation)
  // — this is the one conversion that remains client-side (SettingsSection's plannedPublishAt,
  // and SchedulePicker's browser-side preview `instant`; the Schedule action itself now sends
  // `publishAtLocal` and lets the server convert, per finding 3).
  it("2026-03-08 02:30 BC local (spring-forward gap) -> 2026-03-08T10:30:00.000Z", () => {
    expect(wallClockToInstant(new Date("2026-03-08T02:30:00.000Z"), TZ).toISOString()).toBe("2026-03-08T10:30:00.000Z");
  });

  it("2025-11-02 01:30 BC local (fall-back ambiguous hour) -> 2025-11-02T08:30:00.000Z", () => {
    expect(wallClockToInstant(new Date("2025-11-02T01:30:00.000Z"), TZ).toISOString()).toBe("2025-11-02T08:30:00.000Z");
  });

  it("2026-12-15 14:30 BC local, after BC's permanent UTC-7 switch -> 2026-12-15T21:30:00.000Z (requires Node 24+ tzdata)", () => {
    expect(wallClockToInstant(new Date("2026-12-15T14:30:00.000Z"), TZ).toISOString()).toBe("2026-12-15T21:30:00.000Z");
  });
});

describe("bcLocalToInstant (schedule picker: BC local date+time -> ISO instant)", () => {
  it("converts a BC-local date+time in PDT (UTC-7) to the correct UTC instant", () => {
    expect(bcLocalToInstant("2026-06-15", "14:30", TZ)).toBe("2026-06-15T21:30:00.000Z");
  });

  it("converts a BC-local date+time in PST (UTC-8) to the correct UTC instant", () => {
    expect(bcLocalToInstant("2026-01-15", "14:30", TZ)).toBe("2026-01-15T22:30:00.000Z");
  });

  it("resolves the DST spring-forward gap the same way wallClockToInstant does", () => {
    expect(bcLocalToInstant("2024-03-10", "02:30", TZ)).toBe("2024-03-10T10:30:00.000Z");
  });

  it("rejects a malformed date or time", () => {
    expect(() => bcLocalToInstant("not-a-date", "14:30", TZ)).toThrow();
    expect(() => bcLocalToInstant("2026-06-15", "bad", TZ)).toThrow();
  });
});

describe("instantToBcLocal (the inverse, for pre-filling the picker)", () => {
  it("round-trips a PDT instant back to its BC-local date and time", () => {
    expect(instantToBcLocal("2026-06-15T21:30:00.000Z", TZ)).toEqual({ date: "2026-06-15", time: "14:30" });
  });

  it("round-trips a PST instant back to its BC-local date and time", () => {
    expect(instantToBcLocal("2026-01-15T22:30:00.000Z", TZ)).toEqual({ date: "2026-01-15", time: "14:30" });
  });
});

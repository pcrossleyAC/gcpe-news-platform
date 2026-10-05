import { describe, expect, it } from "vitest";
import { wallClockToInstant } from "./timezone";

const TZ = "America/Vancouver";

describe("wallClockToInstant", () => {
  it("converts an ordinary PDT wall-clock time (no DST ambiguity) to its real UTC instant", () => {
    // 11:52 wall-clock on 2024-06-01 is PDT (UTC-7) -> 18:52 UTC.
    const d = new Date("2024-06-01T11:52:00.000Z"); // UTC fields hold the wall-clock value
    expect(wallClockToInstant(d, TZ).toISOString()).toBe("2024-06-01T18:52:00.000Z");
  });

  it("converts an ordinary PST wall-clock time (no DST ambiguity) to its real UTC instant", () => {
    // 09:00 wall-clock on 2024-02-01 is PST (UTC-8) -> 17:00 UTC.
    const d = new Date("2024-02-01T09:00:00.000Z");
    expect(wallClockToInstant(d, TZ).toISOString()).toBe("2024-02-01T17:00:00.000Z");
  });

  it("fall-back (2024-11-03 2am PDT -> 1am PST): the ambiguous hour resolves to the earlier, PDT instant", () => {
    // Wall-clock 01:30 occurred twice that day: first as PDT (UTC-7, 08:30 UTC), then as PST
    // (UTC-8, 09:30 UTC). The ruling picks the earlier (PDT) instant.
    const d = new Date("2024-11-03T01:30:00.000Z");
    expect(wallClockToInstant(d, TZ).toISOString()).toBe("2024-11-03T08:30:00.000Z");
  });

  it("spring-forward (2024-03-10 2am PST -> 3am PDT): the skipped hour shifts forward", () => {
    // Wall-clock 02:30 never happened that day (clocks jumped from 02:00 PST straight to
    // 03:00 PDT). The ruling shifts it forward by the gap, landing on 03:30 PDT (UTC-7, 10:30 UTC).
    const d = new Date("2024-03-10T02:30:00.000Z");
    expect(wallClockToInstant(d, TZ).toISOString()).toBe("2024-03-10T10:30:00.000Z");
  });

  it("the exact fall-back boundary instant (01:00:00, also ambiguous) still picks the earlier instant", () => {
    const d = new Date("2024-11-03T01:00:00.000Z");
    expect(wallClockToInstant(d, TZ).toISOString()).toBe("2024-11-03T08:00:00.000Z");
  });

  it("the exact spring-forward boundary instant (02:00:00, start of the gap) shifts forward by the gap", () => {
    const d = new Date("2024-03-10T02:00:00.000Z");
    expect(wallClockToInstant(d, TZ).toISOString()).toBe("2024-03-10T10:00:00.000Z");
  });
});

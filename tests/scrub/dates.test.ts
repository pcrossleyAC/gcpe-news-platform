import { describe, expect, it } from "vitest";
import { addDays, bcToday, clampToReference, shiftDateText, shiftWall, wallClockOf, weekOffset } from "../../scripts/lib/scrub/dates";

const wall = (iso: string) => new Date(`${iso}Z`);

describe("dates", () => {
  it("reads BC wall-clock time, including after the move to permanent UTC-7", () => {
    expect(wallClockOf(new Date("2026-10-22T19:00:00Z"), "America/Vancouver").toISOString()).toBe("2026-10-22T12:00:00.000Z");
    expect(wallClockOf(new Date("2026-12-01T19:00:00Z"), "America/Vancouver").toISOString()).toBe("2026-12-01T12:00:00.000Z");
  });

  it("lands the latest kept activity about two weeks after the run, in whole weeks", () => {
    expect(weekOffset(wall("2026-10-12T10:00:00"), wall("2026-10-22T12:00:00"))).toBe(3);
    expect(weekOffset(wall("2026-09-01T10:00:00"), wall("2026-10-22T12:00:00"))).toBe(9);
    expect(weekOffset(wall("2026-12-01T10:00:00"), wall("2026-10-22T12:00:00"))).toBe(0);
  });

  it("keeps weekday and time of day", () => {
    const d = wall("2026-10-12T09:30:00");
    const shifted = shiftWall(d, 3);
    expect(shifted.toISOString()).toBe("2026-11-02T09:30:00.000Z");
    expect(shifted.getUTCDay()).toBe(d.getUTCDay());
  });

  it.each([
    ["10/5/2026 9:00:00 AM", 3, "10/26/2026 9:00:00 AM"],
    ["12/31/2026 11:59:00 PM", 1, "1/7/2027 11:59:00 PM"],
    ["2026-10-05 09:00:00", 3, "2026-10-26 09:00:00"],
    ["2026-10-05T09:00:00.1230000", 1, "2026-10-12T09:00:00.1230000"],
    ["2026-10-05 09:00", 1, "2026-10-12 09:00"],
  ])("shifts log date text %s", (raw, weeks, expected) => expect(shiftDateText(raw, weeks)).toBe(expected));

  it("leaves text it can't read as a date", () => {
    expect(shiftDateText("next Tuesday", 3)).toBeNull();
    expect(shiftDateText("2026-10-05", 3)).toBeNull();
  });

  it("gives BC's date and adds days", () => {
    expect(bcToday(new Date("2026-10-23T06:00:00Z"))).toBe("2026-10-22");
    expect(addDays("2026-10-30", 6)).toBe("2026-11-05");
  });

  it("clamps a stamp that the shift pushed past the run's reference time, and leaves earlier ones alone", () => {
    const reference = wall("2026-10-22T12:00:00");
    const future = wall("2026-11-02T09:30:00");
    const past = wall("2026-10-01T09:30:00");
    expect(clampToReference(future, reference)).toBe(reference);
    expect(clampToReference(past, reference)).toBe(past);
    expect(clampToReference(reference, reference)).toBe(reference);
  });
});

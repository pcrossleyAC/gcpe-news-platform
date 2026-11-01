import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setServerZoneRule } from "./bcTime";
import { BC_RULE, playOldRulesBrowser } from "./oldRulesBrowser.testkit";
import { formatWhen, relativeDay } from "./dates";
import { friendlyDateRange, friendlySpan } from "./calendarDates";
import { bcDateOf, dateTimeText, timeText, todayIn } from "../screens/calendar/list/dates";
import { bcDate, bcDateTime } from "../screens/subscribers/reports/format";
import { formatPublishedAt } from "../screens/website/settings/format";
import { bcLocalToInstant, instantToBcLocal, wallClockNowMinute } from "../screens/release/timezone";
import { scheduledCopy } from "../screens/admin/organizations/CabinetChangeScreen";
import { digestCutoffFor } from "../screens/release/sections/ActionsSection";

/**
 * Every BC-time helper the Hub's screens call, on a browser whose tzdata predates BC's
 * permanent UTC-7 (2026-11-01), once AppShell has the server's rule. Without format/bcTime.ts
 * each of these is an hour (or a day) off for instants after the change.
 */
const BC = "America/Vancouver";
const GO_LIVE = "2026-11-03T16:00:00Z"; // 9:00 AM BC, Tuesday
const plain = (s: string) => s.replace(/\s/g, " ");

let undo: () => void;
beforeEach(() => {
  undo = playOldRulesBrowser();
  setServerZoneRule(BC_RULE);
});
afterEach(() => undo());

describe("BC-time helpers on an old-rules browser, corrected", () => {
  it("format/dates: formatWhen and relativeDay", () => {
    const now = new Date("2026-11-02T18:00:00Z"); // Monday 11:00 AM
    expect(plain(formatWhen(GO_LIVE, now, BC))).toBe("Tomorrow 9:00 AM");
    expect(plain(formatWhen("2026-11-05T16:00:00Z", now, BC, { withDate: true }))).toBe("Thursday, Nov 5 9:00 AM");
    // 00:30 Tuesday BC — an old browser alone calls it Monday 11:30 PM, "Today".
    expect(relativeDay("2026-11-03T07:30:00Z", now, BC)).toBe("Tomorrow");
    expect(plain(formatWhen("2026-01-15T17:00:00Z", now, BC))).toBe("Jan 15, 2026 9:00 AM");
  });

  it("calendar list dates: day, time, today", () => {
    expect(bcDateOf("2026-11-03T07:30:00Z", BC)).toBe("2026-11-03");
    expect(todayIn(BC, new Date("2026-11-03T07:30:00Z"))).toBe("2026-11-03");
    expect(timeText(GO_LIVE, BC)).toBe("9:00 AM");
    expect(dateTimeText(GO_LIVE, BC)).toBe("Nov 3, 2026 9:00 AM");
    expect(dateTimeText("2026-07-15T16:00:00Z", BC)).toBe("Jul 15, 2026 9:00 AM");
  });

  it("calendar-contract's friendly dates and spans", () => {
    const activity = { startAt: GO_LIVE, endAt: "2026-11-03T17:30:00Z", isAllDay: false, isConfirmed: true };
    expect(friendlyDateRange(activity, { timeZone: BC, today: "2026-11-02" })).toBe("Tue Nov 3 9:00-10:30 AM");
    // 23:30 Monday to 00:30 Tuesday BC: the old browser alone would call both Monday.
    expect(friendlySpan(new Date("2026-11-03T06:30:00Z"), new Date("2026-11-03T07:30:00Z"), BC)).toBe("1 Day");
  });

  it("reports, website publish times, cabinet change copy", () => {
    expect(bcDate("2026-11-03T07:30:00Z", BC)).toBe("2026-11-03");
    expect(bcDateTime(GO_LIVE, BC)).toBe("2026-11-03 09:00");
    expect(plain(formatPublishedAt(GO_LIVE, BC))).toBe("Nov 3, 2026, 9:00 AM");
    expect(scheduledCopy({ scheduledFor: GO_LIVE }, BC)).toBe("Publishes on November 3, 2026 at 9:00 a.m. Pacific.");
  });

  it("release schedule: pre-fill, wall-clock back to an instant, now, digest cutoff", () => {
    expect(instantToBcLocal(GO_LIVE, BC)).toEqual({ date: "2026-11-03", time: "09:00" });
    expect(bcLocalToInstant("2026-11-03", "09:00", BC)).toBe("2026-11-03T16:00:00.000Z");
    expect(wallClockNowMinute(Date.parse(GO_LIVE), BC, null)).toBe("2026-11-03T09:00");
    expect(digestCutoffFor("2026-11-03T23:30:00Z", BC)).toBe("2026-11-04T00:00:00.000Z"); // 5 pm BC is 00:00Z
  });
});

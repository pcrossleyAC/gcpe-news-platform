import { describe, expect, it } from "vitest";
import { activityPath, changesPath, safeCalendarReturn } from "./paths";

describe("the editor's paths (C149)", () => {
  it("carry where to come back to", () => {
    expect(activityPath(20001)).toBe("/calendar/activities/20001");
    expect(activityPath("new", "/calendar?q=%7B%7D")).toBe("/calendar/activities/new?return=%2Fcalendar%3Fq%3D%257B%257D");
    expect(changesPath(20001, "/calendar")).toBe("/calendar/activities/20001/changes?return=%2Fcalendar");
  });

  it("only Calendar paths come back; anything else is the list", () => {
    expect(safeCalendarReturn("/calendar?q=%7B%7D&view=month")).toBe("/calendar?q=%7B%7D&view=month");
    expect(safeCalendarReturn("/calendar/activities/20001")).toBe("/calendar/activities/20001");
    for (const bad of [null, "", "https://example.test/", "//example.test/calendar", "/releases/1", "/calendarx", "calendar"]) {
      expect(safeCalendarReturn(bad)).toBe("/calendar");
    }
  });
});

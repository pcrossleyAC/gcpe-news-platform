import { describe, expect, it } from "vitest";
import { clockLabel, freezeMessage, inFreezeWindow } from "./freeze";

const s = (hms: string) => hms.split(":").map(Number).reduce((acc, v) => acc * 60 + v, 0);

describe("the freeze window [start, end)", () => {
  it("is in force from the start's first second to just before the end", () => {
    expect(inFreezeWindow(s("15:59:59"), "16:00", "17:00")).toBe(false);
    expect(inFreezeWindow(s("16:00:00"), "16:00", "17:00")).toBe(true);
    expect(inFreezeWindow(s("16:59:59"), "16:00", "17:00")).toBe(true);
    expect(inFreezeWindow(s("17:00:00"), "16:00", "17:00")).toBe(false);
  });
  it("is off when start and end are equal", () => expect(inFreezeWindow(s("16:00:00"), "16:00", "16:00")).toBe(false));
  it("wraps past midnight when the start is after the end", () => {
    expect(inFreezeWindow(s("23:30:00"), "23:00", "01:00")).toBe(true);
    expect(inFreezeWindow(s("00:30:00"), "23:00", "01:00")).toBe(true);
    expect(inFreezeWindow(s("01:00:00"), "23:00", "01:00")).toBe(false);
  });
});

describe("the freeze message (UCFlexiGrid.ascx:124), from the configured times", () => {
  it("labels times as legacy does", () => {
    expect(clockLabel("16:00")).toBe("4pm");
    expect(clockLabel("16:30")).toBe("4:30pm");
    expect(clockLabel("00:00")).toBe("12am");
    expect(clockLabel("12:00")).toBe("12pm");
  });
  it("names the window", () => {
    expect(freezeMessage("16:00", "17:00")).toBe(
      "You cannot make content changes between 4pm-5pm. Contact the Corp Cal Manager to have emerging or urgent updates made for you during this time.",
    );
  });
});

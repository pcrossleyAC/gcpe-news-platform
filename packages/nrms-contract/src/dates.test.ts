import { describe, expect, it } from "vitest";
import { formatLongDate } from "./dates";

describe("formatLongDate", () => {
  it("formats a calendar date in long form", () => {
    expect(formatLongDate("2024-11-18")).toBe("November 18, 2024");
    expect(formatLongDate("2017-07-08")).toBe("July 8, 2017");
  });
});

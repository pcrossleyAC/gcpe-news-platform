import { describe, expect, it } from "vitest";
import { CHANGE_ACTIONS } from "./enums";
import { FEED_ACTIONS, FEED_KEYWORD_MAX, feedQuerySchema } from "./feed";

describe("the updates feed's query (spec addendum §9.1)", () => {
  it("has legacy's views: latest 5, today, a date range, one activity", () => {
    expect(feedQuerySchema.parse({ mode: "latest" })).toEqual({ mode: "latest" });
    expect(feedQuerySchema.parse({ mode: "today" })).toEqual({ mode: "today" });
    expect(feedQuerySchema.parse({ mode: "range", from: "2026-11-01", to: "2026-11-03", type: "updated", keyword: "  Sample words " })).toEqual({
      mode: "range", from: "2026-11-01", to: "2026-11-03", type: "updated", keyword: "Sample words",
    });
    expect(feedQuerySchema.parse({ mode: "activity", activity: "20001" })).toEqual({ mode: "activity", activity: 20001 });
  });

  it("a date range may leave out either end, or be a single day", () => {
    expect(feedQuerySchema.parse({ mode: "range" })).toEqual({ mode: "range" });
    expect(feedQuerySchema.parse({ mode: "range", to: "2026-11-01" })).toEqual({ mode: "range", to: "2026-11-01" });
    expect(feedQuerySchema.safeParse({ mode: "range", from: "2026-11-01", to: "2026-11-01" }).success).toBe(true);
  });

  it("refuses From after To", () => {
    const r = feedQuerySchema.safeParse({ mode: "range", from: "2026-11-05", to: "2026-11-01" });
    expect(r.success).toBe(false);
    expect(r.error?.issues[0]).toMatchObject({ path: ["to"], message: "From must be on or before To" });
  });

  it("offers legacy's five kinds of update, all of them history actions, and no others", () => {
    expect(FEED_ACTIONS.every((a) => (CHANGE_ACTIONS as readonly string[]).includes(a))).toBe(true);
    for (const type of ["transferred", "la_status_cleared", "added", "changed"]) expect(feedQuerySchema.safeParse({ mode: "range", type }).success, type).toBe(false);
  });

  it("refuses unknown views, stray parameters and unbounded values", () => {
    const bad: object[] = [
      {},
      { mode: "since_last_visit" },
      { mode: "latest", from: "2026-11-01" },
      { mode: "today", keyword: "sample" },
      { mode: "range", keyword: "x".repeat(FEED_KEYWORD_MAX + 1) },
      { mode: "range", keyword: "a\u0000b" },
      { mode: "range", from: "2026-02-30" },
      { mode: "range", from: "1899-12-31" },
      { mode: "range", from: ["2026-11-01", "2026-11-02"] },
      { mode: "range", sort: "at" },
      { mode: "activity" },
      { mode: "activity", activity: "0" },
      { mode: "activity", activity: "1234567890" },
      { mode: "activity", activity: "12a" },
    ];
    for (const q of bad) expect(feedQuerySchema.safeParse(q).success, JSON.stringify(q)).toBe(false);
    expect(feedQuerySchema.safeParse({ mode: "range", keyword: "x".repeat(FEED_KEYWORD_MAX) }).success).toBe(true);
  });
});

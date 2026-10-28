import { describe, expect, it } from "vitest";
import { headerRowFailures } from "../scripts/site-quality";

const header = { x: 0, y: 0, width: 390, height: 75 };
const h1 = { x: 46, y: 106, width: 298, height: 54 };
const row = { live: { x: 205, y: 21, width: 40, height: 40 }, menu: { x: 294, y: 21, width: 40, height: 40 }, search: { x: 339, y: 21, width: 40, height: 40 } };

describe("site-quality: the phone header keeps one row while live", () => {
  it("passes when every control sits inside the header bar, clear of the h1", () => {
    expect(headerRowFailures("/a/ at 390px live", { header, h1, controls: row })).toEqual([]);
  });

  it("a control wrapped below the bar fails, and so does one overlapping the h1", () => {
    // What 6f15fce..bb0ea79 rendered: the words "Live Webcast" pushed the search toggle to a second row.
    const wrapped = { ...row, search: { x: 5, y: 73, width: 40, height: 40 } };
    expect(headerRowFailures("/a/ at 390px live", { header, h1: { ...h1, x: 0 }, controls: wrapped })).toEqual([
      "/a/ at 390px live: search ends at y=113, below the header bar (75)",
      "/a/ at 390px live: search overlaps the h1",
    ]);
  });

  it("a control that isn't rendered is skipped (the live button off, no search toggle); a missing header fails", () => {
    expect(headerRowFailures("/a/", { header, h1, controls: { ...row, live: null } })).toEqual([]);
    expect(headerRowFailures("/a/", { header: null, h1, controls: row })).toEqual(["/a/: the header is not rendered"]);
  });
});

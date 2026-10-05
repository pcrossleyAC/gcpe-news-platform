import { describe, expect, it } from "vitest";
import { moveItemBy, moveItemTo } from "./reorder";

describe("moveItemBy/moveItemTo", () => {
  it("moveItemBy moves an item one slot earlier or later, no-op at either end", () => {
    expect(moveItemBy(["a", "b", "c"], 0, -1)).toEqual(["a", "b", "c"]);
    expect(moveItemBy(["a", "b", "c"], 0, 1)).toEqual(["b", "a", "c"]);
    expect(moveItemBy(["a", "b", "c"], 2, 1)).toEqual(["a", "b", "c"]);
  });

  it("moveItemTo moves an item to an arbitrary position, clamped into range", () => {
    expect(moveItemTo(["a", "b", "c"], 0, 2)).toEqual(["b", "c", "a"]);
    expect(moveItemTo(["a", "b", "c"], 2, 0)).toEqual(["c", "a", "b"]);
    expect(moveItemTo(["a", "b", "c"], 0, 99)).toEqual(["b", "c", "a"]);
  });
});

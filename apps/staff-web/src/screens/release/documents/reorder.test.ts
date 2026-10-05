import { describe, expect, it } from "vitest";
import { moveBy, moveTo, orderedIds } from "./reorder";

describe("orderedIds", () => {
  it("sorts by sortIndex, not array order", () => {
    expect(orderedIds([{ id: "b", sortIndex: 1 }, { id: "a", sortIndex: 0 }])).toEqual(["a", "b"]);
  });
});

describe("moveBy (the Move up/Move down buttons — acceptance 3)", () => {
  it("moves an item up or down by one", () => {
    expect(moveBy(["a", "b", "c"], 1, -1)).toEqual(["b", "a", "c"]);
    expect(moveBy(["a", "b", "c"], 1, 1)).toEqual(["a", "c", "b"]);
  });

  it("is a no-op at either end", () => {
    expect(moveBy(["a", "b", "c"], 0, -1)).toEqual(["a", "b", "c"]);
    expect(moveBy(["a", "b", "c"], 2, 1)).toEqual(["a", "b", "c"]);
  });
});

describe("moveTo (drag-and-drop)", () => {
  it("moves the dragged item to the drop index", () => {
    expect(moveTo(["a", "b", "c"], 0, 2)).toEqual(["b", "c", "a"]);
    expect(moveTo(["a", "b", "c"], 2, 0)).toEqual(["c", "a", "b"]);
  });

  it("clamps an out-of-range drop target", () => {
    expect(moveTo(["a", "b", "c"], 0, 99)).toEqual(["b", "c", "a"]);
  });
});

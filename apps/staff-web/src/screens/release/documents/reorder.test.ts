import { describe, expect, it } from "vitest";
import { orderedIds } from "./reorder";

describe("orderedIds", () => {
  it("sorts by sortIndex, not array order", () => {
    expect(orderedIds([{ id: "b", sortIndex: 1 }, { id: "a", sortIndex: 0 }])).toEqual(["a", "b"]);
  });
});

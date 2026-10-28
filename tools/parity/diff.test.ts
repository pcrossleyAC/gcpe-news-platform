import { PNG } from "pngjs";
import { describe, expect, it } from "vitest";
import { bestRowOffsetMismatch, regionMismatch } from "./diff";

function solid(w: number, h: number, rgb: [number, number, number] = [0x01, 0x33, 0x66]): PNG {
  const png = new PNG({ width: w, height: h });
  for (let i = 0; i < w * h; i++) {
    png.data[i * 4] = rgb[0];
    png.data[i * 4 + 1] = rgb[1];
    png.data[i * 4 + 2] = rgb[2];
    png.data[i * 4 + 3] = 255;
  }
  return png;
}

describe("regionMismatch", () => {
  it("identical images have ratio 0", () => {
    expect(regionMismatch(solid(10, 10), solid(10, 10)).ratio).toBe(0);
  });

  it("one differing pixel in 100 is 0.01", () => {
    const b = solid(10, 10);
    b.data[0] = 255;
    b.data[1] = 255;
    b.data[2] = 255;
    const { ratio, diff } = regionMismatch(solid(10, 10), b);
    expect(ratio).toBeCloseTo(0.01, 10);
    expect(diff.width).toBe(10);
  });

  it("a size difference counts as mismatch", () => {
    // 10x10 vs 10x12: overlap 100 identical, 20 pixels only in one image, max area 120.
    expect(regionMismatch(solid(10, 10), solid(10, 12)).ratio).toBeCloseTo(20 / 120, 10);
  });

  it("clamps the ratio at 1 when the shapes barely overlap", () => {
    // 10x1 vs 1x10: overlap 1, 18 pixels outside it, max area 10 -> 1.9 unclamped.
    expect(regionMismatch(solid(10, 1), solid(1, 10)).ratio).toBe(1);
  });
});

/** 10x10 white image with a black row at `row`. */
function stripe(row: number, h = 10): PNG {
  const png = solid(10, h, [255, 255, 255]);
  for (let x = 0; x < 10; x++) png.data.fill(0, (row * 10 + x) * 4, (row * 10 + x) * 4 + 3);
  return png;
}

describe("bestRowOffsetMismatch", () => {
  it("is 0 when the same content is one row lower in either image (sub-pixel crop offset)", () => {
    expect(regionMismatch(stripe(5), stripe(6)).ratio).toBeGreaterThan(0.03);
    expect(bestRowOffsetMismatch(stripe(5), stripe(6)).ratio).toBe(0);
    expect(bestRowOffsetMismatch(stripe(6), stripe(5)).ratio).toBe(0);
  });

  it("still reports a real difference that no one-row offset explains", () => {
    expect(bestRowOffsetMismatch(stripe(2), stripe(7)).ratio).toBeGreaterThan(0.03);
  });

  it("never does worse than the unshifted comparison", () => {
    const a = stripe(4);
    expect(bestRowOffsetMismatch(a, stripe(4)).ratio).toBe(0);
    expect(bestRowOffsetMismatch(solid(10, 10), solid(10, 12)).ratio).toBeLessThanOrEqual(regionMismatch(solid(10, 10), solid(10, 12)).ratio);
  });
});

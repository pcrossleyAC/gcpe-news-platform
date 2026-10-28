import { PNG } from "pngjs";
import { describe, expect, it } from "vitest";
import { regionMismatch } from "./diff";

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
});

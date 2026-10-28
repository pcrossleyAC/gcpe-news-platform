import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";

/**
 * Compares two region screenshots. The overlapping min(w) x min(h) area goes through pixelmatch;
 * every pixel outside the overlap (in either image) counts as a mismatch.
 * ratio = (mismatched + areaA + areaB - 2*overlap) / max(areaA, areaB).
 * The returned diff PNG is overlap-sized (at least 1x1 so it can always be written).
 */
export function regionMismatch(a: PNG, b: PNG): { ratio: number; diff: PNG } {
  const w = Math.min(a.width, b.width);
  const h = Math.min(a.height, b.height);
  const overlap = w * h;
  const diff = new PNG({ width: Math.max(w, 1), height: Math.max(h, 1) });
  let mismatched = 0;
  if (overlap > 0) {
    mismatched = pixelmatch(crop(a, w, h), crop(b, w, h), diff.data, w, h, { threshold: 0.1 });
  }
  const areaA = a.width * a.height;
  const areaB = b.width * b.height;
  const biggest = Math.max(areaA, areaB);
  const ratio = biggest === 0 ? 0 : (mismatched + (areaA + areaB - 2 * overlap)) / biggest;
  return { ratio, diff };
}

function crop(src: PNG, w: number, h: number): Uint8Array {
  if (src.width === w && src.height === h) return src.data;
  const out = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    out.set(src.data.subarray(y * src.width * 4, y * src.width * 4 + w * 4), y * w * 4);
  }
  return out;
}

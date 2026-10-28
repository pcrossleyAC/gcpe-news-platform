import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";

/**
 * Compares two region screenshots. The overlapping min(w) x min(h) area goes through pixelmatch;
 * every pixel outside the overlap (in either image) counts as a mismatch.
 * ratio = (mismatched + areaA + areaB - 2*overlap) / max(areaA, areaB), clamped at 1 (very different
 * shapes would otherwise exceed it).
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
  const ratio = biggest === 0 ? 0 : Math.min(1, (mismatched + (areaA + areaB - 2 * overlap)) / biggest);
  return { ratio, diff };
}

/**
 * regionMismatch at the best of row offsets -1, 0 and +1. Element screenshots are cut at the
 * element's rounded box, so a fractional page offset (e.g. top 120.4 vs 120.6) can put identical
 * content one row apart; a shift trims |offset| rows from the top of one image and the bottom of
 * the other before comparing. A real difference survives every shift.
 */
export function bestRowOffsetMismatch(a: PNG, b: PNG): { ratio: number; diff: PNG; offset: number } {
  let best = { ...regionMismatch(a, b), offset: 0 };
  if (a.height <= 1 || b.height <= 1) return best;
  // +1: a's content sits one row lower than b's; -1: b's does.
  const shifts: [number, PNG, PNG][] = [
    [1, rows(a, 1, a.height), rows(b, 0, b.height - 1)],
    [-1, rows(a, 0, a.height - 1), rows(b, 1, b.height)],
  ];
  for (const [offset, x, y] of shifts) {
    const r = regionMismatch(x, y);
    if (r.ratio < best.ratio) best = { ...r, offset };
  }
  return best;
}

/** Rows [from, to) of src as a new PNG. */
function rows(src: PNG, from: number, to: number): PNG {
  const out = new PNG({ width: src.width, height: to - from });
  src.data.copy(out.data, 0, from * src.width * 4, to * src.width * 4);
  return out;
}

function crop(src: PNG, w: number, h: number): Uint8Array {
  if (src.width === w && src.height === h) return src.data;
  const out = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    out.set(src.data.subarray(y * src.width * 4, y * src.width * 4 + w * 4), y * w * 4);
  }
  return out;
}

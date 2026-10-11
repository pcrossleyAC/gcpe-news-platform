import { describe, expect, it } from "vitest";
import { QueryVectorCache } from "./vector-cache";

describe("QueryVectorCache (spec §5.4)", () => {
  it("keeps a vector for five minutes", () => {
    let now = 0;
    const cache = new QueryVectorCache({ now: () => now });
    cache.set("salmon", [1, 2]);
    now = 299_999;
    expect(cache.get("salmon")).toEqual([1, 2]);
    now = 300_000;
    expect(cache.get("salmon")).toBeUndefined();
    expect(cache.size).toBe(0);
  });

  it("drops the oldest entry first at the cap", () => {
    const cache = new QueryVectorCache({ maxEntries: 3 });
    for (const k of ["a", "b", "c", "d"]) cache.set(k, [k.charCodeAt(0)]);
    expect(cache.size).toBe(3);
    expect(cache.get("a")).toBeUndefined();
    expect(cache.get("d")).toEqual([100]);
  });

  it("treats a re-set entry as the newest", () => {
    const cache = new QueryVectorCache({ maxEntries: 3 });
    for (const k of ["a", "b", "c"]) cache.set(k, [1]);
    cache.set("a", [2]);
    cache.set("d", [3]);
    expect(cache.get("b")).toBeUndefined();
    expect(cache.get("a")).toEqual([2]);
  });

  it("defaults to 5,000 entries", () => {
    const cache = new QueryVectorCache();
    for (let i = 0; i < 5_001; i++) cache.set(`q${i}`, [i]);
    expect(cache.size).toBe(5_000);
    expect(cache.get("q0")).toBeUndefined();
  });
});

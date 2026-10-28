import { describe, expect, it } from "vitest";
import { cacheMisses } from "./reference-cache";

describe("cacheMisses (NEWS-n negative cache)", () => {
  function counting(answers: Record<string, string | null>) {
    const calls: string[] = [];
    const lookup = async (r: string) => {
      calls.push(r);
      if (!(r in answers)) throw new Error("db down");
      return answers[r]!;
    };
    return { calls, lookup };
  }

  it("a reference with no published post is looked up once per TTL", async () => {
    let now = 1_000;
    const { calls, lookup } = counting({ "NEWS-1": null });
    const cached = cacheMisses(lookup, { ttlMs: 60_000, now: () => now });
    expect(await cached("NEWS-1")).toBeNull();
    now += 59_999;
    expect(await cached("NEWS-1")).toBeNull();
    expect(calls).toEqual(["NEWS-1"]);
    now += 1;
    expect(await cached("NEWS-1")).toBeNull();
    expect(calls).toEqual(["NEWS-1", "NEWS-1"]);
  });

  it("a found post is never cached (it can be unpublished), nor is a failed lookup", async () => {
    const { calls, lookup } = counting({ "NEWS-2": "2026TT0103-001121" });
    const cached = cacheMisses(lookup);
    expect(await cached("NEWS-2")).toBe("2026TT0103-001121");
    expect(await cached("NEWS-2")).toBe("2026TT0103-001121");
    await expect(cached("NEWS-3")).rejects.toThrow("db down");
    await expect(cached("NEWS-3")).rejects.toThrow("db down");
    expect(calls).toEqual(["NEWS-2", "NEWS-2", "NEWS-3", "NEWS-3"]);
  });

  it("holds at most `max` misses, dropping the oldest", async () => {
    const answers = Object.fromEntries(Array.from({ length: 4 }, (_, i) => [`NEWS-${i}`, null]));
    const { calls, lookup } = counting(answers);
    const cached = cacheMisses(lookup, { max: 3 });
    for (const r of ["NEWS-0", "NEWS-1", "NEWS-2", "NEWS-3"]) await cached(r);
    calls.length = 0;
    await cached("NEWS-3");
    await cached("NEWS-1");
    await cached("NEWS-0");
    expect(calls).toEqual(["NEWS-0"]);
  });

  it("is case-insensitive in the reference, as the lookup is", async () => {
    const { calls, lookup } = counting({ "NEWS-5": null, "news-5": null });
    const cached = cacheMisses(lookup);
    await cached("NEWS-5");
    await cached("news-5");
    expect(calls).toEqual(["NEWS-5"]);
  });
});

import { describe, expect, it } from "vitest";
import committed from "./ministry-renames.json";
import { loadRenames } from "./ministry-renames";

describe("loadRenames", () => {
  it("closes chains: international-trade → jobs-and-economic-growth; forests-lands-and-natural-resource-operations → forests; advanced-education → post-secondary-education-and-future-skills", () => {
    const { ministries, sectors } = loadRenames(committed);
    expect(ministries.get("international-trade")).toBe("jobs-and-economic-growth");
    expect(ministries.get("forests-lands-and-natural-resource-operations")).toBe("forests");
    expect(ministries.get("advanced-education")).toBe("post-secondary-education-and-future-skills");
    expect(ministries.get("jobs-economic-recovery-and-innovation/trade")).toBe("jobs-and-economic-growth");
    expect(sectors.get("families")).toBe("services");
  });

  it("no closed value is a key; a cycle throws; a bad key throws", () => {
    const { ministries } = loadRenames(committed);
    for (const [key, value] of ministries) {
      expect(value, key).toMatch(/^[a-z0-9-]+$/);
      expect(ministries.has(value), `${key} → ${value}`).toBe(false);
    }
    expect(() => loadRenames({ ministries: { a: "b", b: "a" }, sectors: {} })).toThrow(/cycle/i);
    expect(() => loadRenames({ ministries: { a: "a" }, sectors: {} })).toThrow(/cycle/i);
    expect(() => loadRenames({ ministries: { "Bad Key": "b" }, sectors: {} })).toThrow();
    expect(() => loadRenames({ ministries: { a: "b/c" }, sectors: {} })).toThrow();
    expect(() => loadRenames({ ministries: { "a/B": "c" }, sectors: {} })).toThrow();
    expect(() => loadRenames({ ministries: { "a/b/c": "d" }, sectors: {} })).toThrow();
    expect(() => loadRenames({ ministries: {}, sectors: { x: "../y" } })).toThrow();
    expect(() => loadRenames({ nope: 1 })).toThrow();
  });

  it("the committed JSON loads", () => {
    const { ministries, sectors } = loadRenames(committed);
    expect(ministries.size).toBe(Object.keys(committed.ministries).length);
    expect(ministries.get("justice")).toBe("attorney-general");
    expect(sectors.size).toBe(1);
  });
});

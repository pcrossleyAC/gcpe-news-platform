import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import committed from "./ministry-renames.json";
import { loadRenames, resolveCategory } from "./ministry-renames";

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

describe("resolveCategory fallbacks when the moved-to key has no page", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "gcpe-renames-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  const put = async (rel: string, body: string) => {
    await mkdir(dirname(join(dir, rel)), { recursive: true });
    await writeFile(join(dir, rel), body);
  };

  it("a two-segment rename whose value has no page falls back to the first segment's page", async () => {
    await put("ministries/jobs-economic-recovery-and-innovation/index.html", "x");
    expect(await resolveCategory(dir, "ministries", ["jobs-economic-recovery-and-innovation", "trade"])).toEqual({ key: "jobs-economic-recovery-and-innovation", consumed: 1, moved: true });
  });

  it("...and with the rename value's page built, the rename wins as before", async () => {
    await put("ministries/jobs-economic-recovery-and-innovation/index.html", "x");
    await put("ministries/jobs-and-economic-growth/index.html", "x");
    expect(await resolveCategory(dir, "ministries", ["jobs-economic-recovery-and-innovation", "trade"])).toEqual({ key: "jobs-and-economic-growth", consumed: 2, moved: true });
  });

  it("a successor with no page falls back to the key it replaces when that has a page", async () => {
    await put("ministries/old-min/index.html", "x");
    await put("legacy/ministry-successors.json", JSON.stringify({ successors: { "old-min": "ghost" } }));
    expect(await resolveCategory(dir, "ministries", ["old-min"])).toEqual({ key: "old-min", consumed: 1, moved: false });
  });

  it("...and with the successor's page built, the successor wins as before", async () => {
    await put("ministries/old-min/index.html", "x");
    await put("ministries/ghost/index.html", "x");
    await put("legacy/ministry-successors.json", JSON.stringify({ successors: { "old-min": "ghost" } }));
    expect(await resolveCategory(dir, "ministries", ["old-min"])).toEqual({ key: "ghost", consumed: 1, moved: true });
  });

  it("with no page anywhere along the way it is still null", async () => {
    expect(await resolveCategory(dir, "ministries", ["international-trade"])).toBeNull();
    expect(await resolveCategory(dir, "ministries", ["jobs-economic-recovery-and-innovation", "trade"])).toBeNull();
  });
});

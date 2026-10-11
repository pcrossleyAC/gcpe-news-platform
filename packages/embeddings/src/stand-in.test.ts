import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { standInProvider } from "./stand-in";

const cosine = (a: number[], b: number[]) => a.reduce((s, x, i) => s + x * b[i]!, 0);

describe("standInProvider", () => {
  const p = standInProvider();

  it("meets the provider contract: id, model, 1536 unit-length vectors, one per text, in order", async () => {
    expect(p.id).toBe("stand-in");
    expect(p.model).toBe("stand-in-sha256-v1");
    expect(p.dimensions).toBe(1536);
    const out = await p.embed(["one", "two words", ""]);
    expect(out).toHaveLength(3);
    for (const v of out) {
      expect(v).toHaveLength(1536);
      expect(Math.sqrt(v.reduce((s, x) => s + x * x, 0))).toBeCloseTo(1, 10);
      expect(v.some(Number.isNaN)).toBe(false);
    }
    expect(await p.embed([])).toEqual([]);
  });

  it("gives fixed output: the same text always gets the same vector", async () => {
    const [v] = await p.embed(["Wildfire crews contain blaze near Kamloops"]);
    // Pinned while planning, from this exact algorithm.
    expect(createHash("sha256").update(JSON.stringify(v)).digest("hex")).toBe(
      "3b07e18bfffaad3afc2fb44d6417bd6f9eca86bddc15cef65ede3d0c06804438",
    );
  });

  it("puts texts that share words closer than texts that share none", async () => {
    const [a, b, c] = await p.embed([
      "Wildfire crews contain blaze near Kamloops",
      "Wildfire crews contain blaze near Kelowna",
      "School district budget announced",
    ]);
    expect(cosine(a!, b!)).toBeGreaterThan(0.8);
    expect(cosine(a!, c!)).toBeLessThan(0.2);
  });

  it("ignores case and punctuation", async () => {
    const [a, b] = await p.embed(["WILDFIRE, crews!", "wildfire crews"]);
    expect(cosine(a!, b!)).toBeCloseTo(1, 10);
  });
});

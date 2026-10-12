import { describe, expect, it } from "vitest";
import { runSpotCheck, SPOT_QUERIES } from "../scripts/search-spot-check";

describe("search spot-check (spec §9 exit)", () => {
  it("text mode puts every expected key in the top 5; the stand-in run says it proves only the plumbing", async () => {
    const lines: string[] = [];
    const r = await runSpotCheck({ log: (l) => lines.push(l) });
    expect(SPOT_QUERIES.length).toBeGreaterThanOrEqual(20);
    expect(r.textHits).toBe(SPOT_QUERIES.length);
    expect(r.semanticReached).toBe(true);
    expect(r.ok).toBe(true);
    expect(lines.join("\n")).toMatch(/stand-in provider proves only the plumbing/i);
    expect(lines.join("\n")).toContain("Q70");
  }, 60_000);
});

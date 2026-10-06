import { describe, expect, it } from "vitest";
import { priorityFor } from "./priority";
describe("priorityFor", () => {
  it("uses the spec's base priorities", () => {
    expect([priorityFor("system", "a@x.com", []), priorityFor("media", "a@x.com", []), priorityFor("immediate", "a@x.com", []), priorityFor("digest", "a@x.com", [])]).toEqual([100, 40, 30, 20]);
  });
  it("adds 2 for internal domains, case-insensitively, exact domain only", () => {
    expect(priorityFor("immediate", "Alex.Example@GOV.BC.CA", ["gov.bc.ca"])).toBe(32);
    expect(priorityFor("immediate", "a@notgov.bc.ca", ["gov.bc.ca"])).toBe(30);
  });
});

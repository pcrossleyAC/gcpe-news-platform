import { describe, expect, it } from "vitest";
import { createFakeSource } from "./source";

describe("createFakeSource", () => {
  it("returns rows registered under the query's -- name: line", async () => {
    const src = createFakeSource({ ministries: [{ Key: "health" }] });
    expect(await src.query("-- name: ministries\nSELECT * FROM dbo.Ministry")).toEqual([{ Key: "health" }]);
  });

  it("throws for an unregistered query name", async () => {
    const src = createFakeSource({});
    await expect(src.query("-- name: nope\nSELECT 1")).rejects.toThrow(/nope/);
  });
});

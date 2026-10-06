import { describe, expect, it } from "vitest";
import { z } from "zod";
import { formatIssues } from "./issues";

describe("formatIssues", () => {
  it("joins each issue as path: message", () => {
    const r = z.object({ a: z.string(), b: z.object({ c: z.number() }) }).safeParse({ a: 1, b: { c: "x" } });
    expect(r.success).toBe(false);
    expect(formatIssues(r.error!)).toBe("a: Expected string, received number; b.c: Expected number, received string");
  });
});

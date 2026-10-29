import { describe, expect, it } from "vitest";
import { trustProxyHopsFrom } from "./index";

describe("trustProxyHopsFrom", () => {
  it("defaults to 1 hop when unset or empty", () => {
    expect(trustProxyHopsFrom({})).toBe(1);
    expect(trustProxyHopsFrom({ TRUST_PROXY_HOPS: "" })).toBe(1);
  });
  it("accepts whole numbers 1 to 5", () => {
    for (const n of [1, 2, 5]) expect(trustProxyHopsFrom({ TRUST_PROXY_HOPS: String(n) })).toBe(n);
  });
  it.each(["abc", "0", "-1", "6", "1.5", "2 hops"])("refuses %j with a clear message", (v) => {
    expect(() => trustProxyHopsFrom({ TRUST_PROXY_HOPS: v })).toThrow(/TRUST_PROXY_HOPS/);
  });
});

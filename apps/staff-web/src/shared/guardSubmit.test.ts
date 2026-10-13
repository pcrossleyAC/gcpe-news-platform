import { describe, expect, it, vi } from "vitest";
import { ignoreWhileBusy } from "./guardSubmit";

describe("ignoreWhileBusy", () => {
  it("always prevents the default submit", () => {
    const preventDefault = vi.fn();
    ignoreWhileBusy(false, { preventDefault });
    ignoreWhileBusy(true, { preventDefault });
    expect(preventDefault).toHaveBeenCalledTimes(2);
  });

  it("reports busy so the caller stops, and idle so it proceeds", () => {
    expect(ignoreWhileBusy(true, { preventDefault: () => {} })).toBe(true);
    expect(ignoreWhileBusy(false, { preventDefault: () => {} })).toBe(false);
  });
});

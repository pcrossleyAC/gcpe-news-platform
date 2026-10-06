import { afterEach, describe, expect, it } from "vitest";
import { installErrorCapture } from "./errors";

describe("installErrorCapture", () => {
  let capture: ReturnType<typeof installErrorCapture> | undefined;

  afterEach(() => {
    capture?.close();
    capture = undefined;
  });

  it("records every console.error call as a timestamped entry", () => {
    capture = installErrorCapture();
    console.error("boom", 1);
    const entries = capture.entries();
    expect(entries).toHaveLength(1);
    expect(entries[0]!.message).toBe("boom 1");
    expect(() => new Date(entries[0]!.timestamp).toISOString()).not.toThrow();
  });

  it("still writes through to the original console.error (doesn't silence it)", () => {
    const original = console.error;
    let sawCall = false;
    capture = installErrorCapture();
    // Replace *after* installing, so our capture's `original` reference is this spy — proves
    // the capture forwards rather than swallowing.
    const spy = (...args: unknown[]) => {
      sawCall = true;
      original.apply(console, args);
    };
    capture.close();
    console.error = spy;
    capture = installErrorCapture();
    console.error("x");
    expect(sawCall).toBe(true);
    console.error = original;
  });

  it("keeps only the last `limit` entries", () => {
    capture = installErrorCapture(3);
    for (let i = 0; i < 5; i++) console.error(`e${i}`);
    expect(capture.entries().map((e) => e.message)).toEqual(["e2", "e3", "e4"]);
  });

  it("close() restores the original console.error", () => {
    const original = console.error;
    capture = installErrorCapture();
    expect(console.error).not.toBe(original);
    capture.close();
    expect(console.error).toBe(original);
    capture = undefined;
  });
});

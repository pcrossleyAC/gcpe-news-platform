import { describe, expect, it, vi } from "vitest";
import { createShutdown } from "./shutdown";

describe("createShutdown", () => {
  it("runs closers strictly in order, then exits 0", async () => {
    const order: string[] = [];
    const exit = vi.fn();
    const shutdown = createShutdown({
      closers: [
        { name: "a", close: async () => { await new Promise((r) => setTimeout(r, 10)); order.push("a"); } },
        { name: "b", close: () => void order.push("b") },
      ],
      exit,
    });
    await shutdown();
    expect(order).toEqual(["a", "b"]);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it("is idempotent", async () => {
    const close = vi.fn(async () => {});
    const exit = vi.fn();
    const shutdown = createShutdown({ closers: [{ name: "a", close }], exit });
    await Promise.all([shutdown(), shutdown()]);
    expect(close).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledOnce();
  });

  // Final review D9: a rejecting closer must not leave shutdown as an unhandled rejection
  // with the process hanging — log it, still run the remaining closers, and exit(1).
  it("logs a rejecting closer, still runs the rest, and exits 1", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const later = vi.fn();
    const exit = vi.fn();
    const shutdown = createShutdown({
      logPrefix: "[test]",
      closers: [
        { name: "broken", close: async () => { throw new Error("boom"); } },
        { name: "later", close: later },
      ],
      exit,
    });
    await expect(shutdown()).resolves.toBeUndefined();
    expect(log).toHaveBeenCalledWith("[test] shutdown step failed: broken", expect.any(Error));
    expect(later).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledExactlyOnceWith(1);
    log.mockRestore();
  });

  it("treats a synchronously throwing closer the same way", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const exit = vi.fn();
    const shutdown = createShutdown({ closers: [{ name: "sync", close: () => { throw new Error("boom"); } }], exit });
    await shutdown();
    expect(exit).toHaveBeenCalledExactlyOnceWith(1);
    log.mockRestore();
  });
});

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
});

import { describe, expect, it, vi } from "vitest";
import { safeErrorLabel } from "@gcpe/http-kit";
import { BreakerOpenError, CircuitBreaker } from "./breaker";

function clock() {
  let t = 0;
  return { now: () => t, advance: (ms: number) => void (t += ms) };
}
const fail = () => Promise.reject(new Error("provider down"));
const ok = () => Promise.resolve("ok");
async function failTimes(b: CircuitBreaker, n: number) {
  for (let i = 0; i < n; i++) await b.run(fail).catch(() => {});
}

describe("CircuitBreaker", () => {
  it("defaults to 3 failures and a 60-second cooldown", () => {
    const b = new CircuitBreaker();
    expect([b.failureThreshold, b.cooldownMs, b.state]).toEqual([3, 60_000, "closed"]);
  });

  it("stays closed through two consecutive failures and opens on the third", async () => {
    const b = new CircuitBreaker({ now: clock().now });
    await failTimes(b, 2);
    expect(b.state).toBe("closed");
    await failTimes(b, 1);
    expect(b.state).toBe("open");
  });

  it("counts consecutive failures only: a success resets the count", async () => {
    const b = new CircuitBreaker({ now: clock().now });
    await failTimes(b, 2);
    await b.run(ok);
    await failTimes(b, 2);
    expect(b.state).toBe("closed");
  });

  it("while open, throws BreakerOpenError without calling fn", async () => {
    const b = new CircuitBreaker({ now: clock().now });
    await failTimes(b, 3);
    const fn = vi.fn(ok);
    await expect(b.run(fn)).rejects.toBeInstanceOf(BreakerOpenError);
    expect(fn).not.toHaveBeenCalled();
  });

  it("after the cooldown is half-open: one probe at a time; a success closes it", async () => {
    const c = clock();
    const b = new CircuitBreaker({ now: c.now });
    await failTimes(b, 3);
    c.advance(59_999);
    expect(b.state).toBe("open");
    c.advance(1);
    expect(b.state).toBe("half-open");

    let release!: (v: string) => void;
    const probe = b.run(() => new Promise<string>((r) => (release = r)));
    const second = vi.fn(ok);
    await expect(b.run(second)).rejects.toBeInstanceOf(BreakerOpenError);
    expect(second).not.toHaveBeenCalled();
    release("probed");
    expect(await probe).toBe("probed");
    expect(b.state).toBe("closed");
    await failTimes(b, 2);
    expect(b.state).toBe("closed"); // the count started again from zero
  });

  it("a failed probe re-opens it for a fresh cooldown", async () => {
    const c = clock();
    const b = new CircuitBreaker({ now: c.now });
    await failTimes(b, 3);
    c.advance(60_000);
    await failTimes(b, 1);
    expect(b.state).toBe("open");
    c.advance(59_999);
    await expect(b.run(ok)).rejects.toBeInstanceOf(BreakerOpenError);
    c.advance(1);
    expect(await b.run(ok)).toBe("ok");
  });

  it("treats a synchronous throw from fn as a failure", async () => {
    const b = new CircuitBreaker({ now: clock().now });
    for (let i = 0; i < 3; i++) {
      await b.run(() => { throw new Error("sync"); }).catch(() => {});
    }
    expect(b.state).toBe("open");
  });

  it("labels BreakerOpenError safely", () => {
    expect(safeErrorLabel(new BreakerOpenError())).toBe("breaker_open");
  });
});

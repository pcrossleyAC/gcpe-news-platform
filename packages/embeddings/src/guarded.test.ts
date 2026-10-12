import { describe, expect, it, vi } from "vitest";
import { BreakerOpenError, CircuitBreaker } from "./breaker";
import { createGuardedEmbedder } from "./guarded";
import { EmbeddingError, type EmbeddingProvider } from "./provider";
import { standInProvider } from "./stand-in";

const failing = (err: Error): EmbeddingProvider => ({
  id: "fake", model: "fake-1", dimensions: 3,
  embed: vi.fn(async () => { throw err; }),
});

describe("createGuardedEmbedder", () => {
  it("passes vectors through from the provider", async () => {
    const g = createGuardedEmbedder({ provider: standInProvider(), log: () => {} });
    expect(await g.embed(["a"])).toEqual(await standInProvider().embed(["a"]));
  });

  it("logs a failure with the provider id and a safe label only, never the input text", async () => {
    const lines: string[] = [];
    const g = createGuardedEmbedder({ provider: failing(new Error("cannot embed: Secret draft headline")), log: (l) => lines.push(l) });
    await expect(g.embed(["Secret draft headline"])).rejects.toThrow();
    expect(lines).toEqual(["[embeddings] fake call failed Error"]);

    const lines2: string[] = [];
    const g2 = createGuardedEmbedder({ provider: failing(new EmbeddingError("embedding_http_429")), log: (l) => lines2.push(l) });
    await g2.embed(["x"]).catch(() => {});
    expect(lines2).toEqual(["[embeddings] fake call failed embedding_http_429"]);
  });

  it("opens the breaker after three failures, then rejects with BreakerOpenError without calling the provider or logging", async () => {
    const provider = failing(new Error("down"));
    const lines: string[] = [];
    const g = createGuardedEmbedder({ provider, breaker: new CircuitBreaker({ now: () => 0 }), log: (l) => lines.push(l) });
    for (let i = 0; i < 3; i++) await g.embed(["t"]).catch(() => {});
    expect(provider.embed).toHaveBeenCalledTimes(3);
    await expect(g.embed(["t"])).rejects.toBeInstanceOf(BreakerOpenError);
    expect(provider.embed).toHaveBeenCalledTimes(3);
    expect(lines).toHaveLength(3);
  });

  it("forwards the caller's signal to the breaker, so an aborted call doesn't count toward it", async () => {
    const provider = failing(new DOMException("aborted", "AbortError"));
    const breaker = new CircuitBreaker({ now: () => 0 });
    const g = createGuardedEmbedder({ provider, breaker, log: () => {} });
    const controller = new AbortController();
    controller.abort();
    for (let i = 0; i < 3; i++) await g.embed(["t"], controller.signal).catch(() => {});
    expect(breaker.state).toBe("closed");
  });

  it("doesn't log a call the caller aborted", async () => {
    const lines: string[] = [];
    const provider = {
      id: "p",
      model: "m",
      dimensions: 2,
      embed: (_texts: string[], signal?: AbortSignal) =>
        new Promise<number[][]>((_resolve, reject) => signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")))),
    };
    const guarded = createGuardedEmbedder({ provider, log: (l) => lines.push(l) });
    const controller = new AbortController();
    const pending = guarded.embed(["x"], controller.signal);
    controller.abort();
    await expect(pending).rejects.toThrow();
    expect(lines).toEqual([]);
  });

  it("defaults to console.error and a fresh breaker", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const g = createGuardedEmbedder({ provider: failing(new Error("down")) });
    expect(g.breaker.state).toBe("closed");
    await g.embed(["t"]).catch(() => {});
    expect(error).toHaveBeenCalledWith("[embeddings] fake call failed Error");
    error.mockRestore();
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { azureOpenAiProvider } from "./azure-openai";
import { EmbeddingError } from "./provider";

const settings = {
  endpoint: "https://embeddings.example.test/",
  apiKey: "test-key-not-real",
  deployment: "embed small",
  apiVersion: "2024-10-21",
  timeoutMs: 1000,
};
const vec = (seed: number) => Array.from({ length: 1536 }, (_, i) => (i === seed ? 1 : 0));
const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

describe("azureOpenAiProvider", () => {
  afterEach(() => vi.restoreAllMocks());

  it("posts to the deployment with the key header and dimensions pinned at 1536, and returns vectors in input order", async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
      ok({ data: [{ index: 1, embedding: vec(1) }, { index: 0, embedding: vec(0) }] }),
    );
    const p = azureOpenAiProvider(settings, fetchImpl as unknown as typeof fetch);
    expect([p.id, p.model, p.dimensions]).toEqual(["azure-openai", "text-embedding-3-small", 1536]);
    const out = await p.embed(["first", "second"]);
    expect(out).toEqual([vec(0), vec(1)]);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("https://embeddings.example.test/openai/deployments/embed%20small/embeddings?api-version=2024-10-21");
    expect(init?.method).toBe("POST");
    expect((init?.headers as Record<string, string>)["api-key"]).toBe("test-key-not-real");
    expect(JSON.parse(String(init?.body))).toEqual({ input: ["first", "second"], dimensions: 1536 });
  });

  it("makes no call for no texts", async () => {
    const fetchImpl = vi.fn();
    expect(await azureOpenAiProvider(settings, fetchImpl as unknown as typeof fetch).embed([])).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("turns a non-2xx answer into an EmbeddingError whose code names only the status", async () => {
    const fetchImpl = vi.fn(async () => new Response("quota exceeded for key test-key-not-real", { status: 429 }));
    const err = await azureOpenAiProvider(settings, fetchImpl as unknown as typeof fetch).embed(["t"]).catch((e) => e);
    expect(err).toBeInstanceOf(EmbeddingError);
    expect(err.code).toBe("embedding_http_429");
    expect(String(err.message)).not.toContain("test-key");
  });

  it.each([
    ["the wrong number of vectors", { data: [{ index: 0, embedding: vec(0) }] }],
    ["a vector of the wrong size", { data: [{ index: 0, embedding: [0.1, 0.2] }, { index: 1, embedding: vec(1) }] }],
    ["a malformed body", { nope: true }],
  ])("refuses %s as embedding_bad_response", async (_label, body) => {
    const fetchImpl = vi.fn(async () => ok(body));
    const err = await azureOpenAiProvider(settings, fetchImpl as unknown as typeof fetch).embed(["a", "b"]).catch((e) => e);
    expect(err).toBeInstanceOf(EmbeddingError);
    expect(err.code).toBe("embedding_bad_response");
  });

  it("times out at the clamped timeout, and honours the caller's own signal", async () => {
    const hang = vi.fn(
      (_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason))),
    );
    const started = Date.now();
    const timedOut = await azureOpenAiProvider({ ...settings, timeoutMs: 1 }, hang as unknown as typeof fetch).embed(["t"]).catch((e) => e);
    expect(timedOut.name).toBe("TimeoutError");
    expect(Date.now() - started).toBeGreaterThanOrEqual(190); // 1 ms clamps up to 200 ms

    const controller = new AbortController();
    const pending = azureOpenAiProvider(settings, hang as unknown as typeof fetch).embed(["t"], controller.signal).catch((e) => e);
    controller.abort();
    expect((await pending).name).toBe("AbortError");
  });

  it("never logs", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const fetchImpl = vi.fn(async () => new Response("", { status: 500 }));
    await azureOpenAiProvider(settings, fetchImpl as unknown as typeof fetch).embed(["secret draft text"]).catch(() => {});
    expect(error).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  });
});

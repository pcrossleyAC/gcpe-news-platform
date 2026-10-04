import { describe, expect, it, vi } from "vitest";
import { nodClient } from "./clients";

describe("nodClient", () => {
  it("counts subscribers via a signed GET, encoding the list keys and the bearer token", async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify({ count: 42 }), { status: 200 }));
    const client = nodClient({ baseUrl: "https://nod.example", getToken: async () => "tok", fetchImpl: fetchImpl as unknown as typeof fetch });

    const count = await client.countSubscribers(["ministries:health", "sectors:health"]);

    expect(count).toBe(42);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(String(url)).toBe("https://nod.example/api/subscribers/count?lists=ministries%3Ahealth%2Csectors%3Ahealth");
    expect(init?.headers).toMatchObject({ authorization: "Bearer tok" });
  });

  it("rejects with the status on a non-200 response", async () => {
    const fetchImpl = vi.fn(async () => new Response("boom", { status: 500 }));
    const client = nodClient({ baseUrl: "https://nod.example", getToken: async () => "tok", fetchImpl: fetchImpl as unknown as typeof fetch });

    await expect(client.countSubscribers([])).rejects.toThrow(/NoD count failed: HTTP 500/);
  });
});

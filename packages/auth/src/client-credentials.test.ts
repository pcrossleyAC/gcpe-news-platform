import { describe, expect, it } from "vitest";
import { createClientCredentialsProvider } from "./client-credentials";

describe("createClientCredentialsProvider", () => {
  it("caches the token until 60s before expiry", async () => {
    let calls = 0;
    let now = 1_000_000;
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      calls++;
      expect(String(init.body)).toContain("grant_type=client_credentials");
      return new Response(JSON.stringify({ access_token: `t${calls}`, expires_in: 3600 }), { status: 200 });
    }) as typeof fetch;
    const get = createClientCredentialsProvider({ tokenUrl: "https://x/token", clientId: "c", clientSecret: "s", scope: "api://nod/.default", fetchImpl, now: () => now });
    expect(await get()).toBe("t1");
    now += 3_500_000;
    expect(await get()).toBe("t1");
    now += 50_000;
    expect(await get()).toBe("t2");
  });

  it("throws on a failed token request", async () => {
    const fetchImpl = (async () => new Response("no", { status: 400 })) as typeof fetch;
    const get = createClientCredentialsProvider({ tokenUrl: "https://x/token", clientId: "c", clientSecret: "s", scope: "x", fetchImpl });
    await expect(get()).rejects.toThrow(/400/);
  });
});

import { jwtVerify } from "jose";
import { describe, expect, it } from "vitest";
import { distributionTokenProvider } from "./distribution-token";

const LOCAL_SECRET = "a".repeat(32);
// Mirrors @gcpe/auth's internal localKey (not exported) — an HS256 key is just the secret's
// raw bytes.
const localKey = (secret: string) => new TextEncoder().encode(secret);

describe("distributionTokenProvider", () => {
  it("uses Entra client credentials when all four fields are set", async () => {
    const calls: unknown[] = [];
    const fetchImpl = (async (url: unknown, init: unknown) => {
      calls.push([url, init]);
      return new Response(JSON.stringify({ access_token: "entra-token", expires_in: 3600 }), { status: 200 });
    }) as typeof fetch;

    const getToken = distributionTokenProvider({
      tokenUrl: "https://entra.example/token",
      clientId: "client-id",
      clientSecret: "client-secret",
      scope: "distribution.send",
      local: null,
      fetchImpl,
    });

    expect(await getToken()).toBe("entra-token");
    expect(calls).toHaveLength(1);
    // Cached on a second call — no second fetch.
    expect(await getToken()).toBe("entra-token");
    expect(calls).toHaveLength(1);
  });

  it("throws if only some Entra fields are set", () => {
    expect(() =>
      distributionTokenProvider({
        tokenUrl: "https://entra.example/token",
        clientId: "client-id",
        local: null,
      }),
    ).toThrow(/together, or none/);
  });

  it("mints a cached local token when authFromEnv's local config is set and no Entra fields are given", async () => {
    const getToken = distributionTokenProvider({ local: { username: "admin", passwordHash: "hash", secret: LOCAL_SECRET } });

    const token = await getToken();
    const { payload } = await jwtVerify(token, localKey(LOCAL_SECRET), { algorithms: ["HS256"] });
    expect(payload.sub).toBe("nod");
    expect(payload.azp).toBe("nod");
    expect(payload.roles).toEqual(["Distribution.Send"]);

    // Cached: a second call before expiry returns the identical token.
    expect(await getToken()).toBe(token);
  });

  it("re-mints the local token once fewer than 5 minutes remain", async () => {
    let now = 1_000_000;
    const getToken = distributionTokenProvider({ local: { username: "admin", passwordHash: "hash", secret: LOCAL_SECRET }, now: () => now });

    const first = await getToken();
    // Still safely within the 1h TTL minus the 5-minute margin: cached.
    now += 10 * 60_000;
    expect(await getToken()).toBe(first);
    // Past the refresh margin (55 minutes in): re-minted. Content may be identical (same
    // claims), but the call must not throw and must still verify.
    now += 50 * 60_000;
    const second = await getToken();
    const { payload } = await jwtVerify(second, localKey(LOCAL_SECRET), { algorithms: ["HS256"] });
    expect(payload.sub).toBe("nod");
  });

  it("throws at construction time when neither Entra nor local auth is configured", () => {
    expect(() => distributionTokenProvider({ local: null })).toThrow(/configure DISTRIBUTION_TOKEN_URL.*or enable LOCAL_ADMIN_ENABLED/s);
  });
});

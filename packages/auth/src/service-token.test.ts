import { describe, expect, it, vi } from "vitest";
import { decodeJwt } from "jose";
import { serviceTokenProvider } from "./service-token";

const local = { username: "admin", passwordHash: "x", secret: "s".repeat(40) };

describe("serviceTokenProvider", () => {
  it("mints a local token with the given subject, azp and roles, cached until near expiry", async () => {
    let now = 1_000_000;
    const get = serviceTokenProvider({ local, subject: "nrms", roles: ["NRMS.Editor"], envPrefix: "NOD", now: () => now });
    const t1 = await get();
    expect(decodeJwt(t1)).toMatchObject({ sub: "nrms", azp: "nrms", roles: ["NRMS.Editor"] });
    expect(await get()).toBe(t1);
    now += 56 * 60_000;
    expect(await get()).not.toBe(t1);
  });
  it("uses Entra client credentials when all four are set; refuses a partial set or nothing", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ access_token: "entra-token", expires_in: 3600 }), { status: 200 }));
    const get = serviceTokenProvider({ tokenUrl: "https://login.invalid/token", clientId: "c", clientSecret: "s", scope: "api://nod/.default", local: null, subject: "nrms", roles: [], envPrefix: "NOD", fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(await get()).toBe("entra-token");
    expect(() => serviceTokenProvider({ tokenUrl: "https://x", local, subject: "nrms", roles: [], envPrefix: "NOD" })).toThrow(/NOD_TOKEN_URL, NOD_CLIENT_ID, NOD_CLIENT_SECRET and NOD_SCOPE/);
    expect(() => serviceTokenProvider({ local: null, subject: "nrms", roles: [], envPrefix: "NOD" })).toThrow(/LOCAL_ADMIN_ENABLED/);
  });
});

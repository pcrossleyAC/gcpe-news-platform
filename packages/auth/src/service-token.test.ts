import { describe, expect, it, vi } from "vitest";
import { decodeJwt } from "jose";
import { INTERNAL_ISSUER } from "./internal";
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

  describe("the stack's internal token (2026-10-31, T2)", () => {
    const internal = { secret: "i".repeat(64) };
    const target = "http://stack.internal/nod";

    it("is used for an in-process target when Entra isn't configured, and the break-glass secret is never touched", async () => {
      const mintToken = vi.fn();
      const get = serviceTokenProvider({ internal, targetUrl: target, local, subject: "nrms", roles: ["NoD.SubscriberCount"], envPrefix: "NOD", mintToken });
      expect(decodeJwt(await get())).toMatchObject({ iss: INTERNAL_ISSUER, sub: "nrms", azp: "nrms", roles: ["NoD.SubscriberCount"] });
      expect(mintToken).not.toHaveBeenCalled();
    });

    it("works with local admin off: the stack starts without break-glass", async () => {
      const get = serviceTokenProvider({ internal, targetUrl: target, local: null, subject: "nod", roles: ["Distribution.Send"], envPrefix: "DISTRIBUTION" });
      expect(decodeJwt(await get())).toMatchObject({ iss: INTERNAL_ISSUER, sub: "nod", azp: "nod" });
    });

    it("is cached until near expiry, like the local token", async () => {
      let now = 1_000_000;
      const get = serviceTokenProvider({ internal, targetUrl: target, local: null, subject: "nrms", roles: [], envPrefix: "NOD", now: () => now });
      const t1 = await get();
      expect(await get()).toBe(t1);
      now += 56 * 60_000;
      expect(await get()).not.toBe(t1);
    });

    it("is never sent to a target outside the process (a real Media Hub, say)", () => {
      expect(() => serviceTokenProvider({ internal, targetUrl: "https://media-hub.example.gov.bc.ca", local: null, subject: "nod", roles: [], envPrefix: "NOD_MEDIA_HUB" })).toThrow(/NOD_MEDIA_HUB_TOKEN_URL/);
      expect(() => serviceTokenProvider({ internal, local: null, subject: "nod", roles: [], envPrefix: "NOD" })).toThrow(/NOD_TOKEN_URL/);
    });

    it("loses to Entra client credentials when all four are set", async () => {
      const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ access_token: "entra-token", expires_in: 3600 }), { status: 200 }));
      const get = serviceTokenProvider({ tokenUrl: "https://login.invalid/token", clientId: "c", clientSecret: "s", scope: "x", internal, targetUrl: target, local: null, subject: "nrms", roles: [], envPrefix: "NOD", fetchImpl: fetchImpl as unknown as typeof fetch });
      expect(await get()).toBe("entra-token");
    });
  });
});

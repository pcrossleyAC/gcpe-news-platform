// Owner decision 2026-10-31: a staff session lasts at most 12 hours from sign-in, whatever the
// renewals, and a deactivated user's very next request to any app is refused (the session gate).
import { afterEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import { requireBearer, setSessionGate, type SessionGate } from "./bearer";
import { authFromEnv } from "./from-env";
import { DEFAULT_SESSION_MAX_SECONDS, mintSession, SESSION_COOKIE, verifySession } from "./session";

const secret = "s".repeat(40);
const user = { id: "8a1f0f4e-0000-4000-8000-000000000001", name: "Test Editor", email: "editor@example.test", roles: ["NRMS.Editor"] };
const T0 = new Date("2026-11-02T08:00:00Z");
const s = (d: Date) => Math.floor(d.getTime() / 1000);
const at = (minutesAfterT0: number) => vi.setSystemTime(new Date(T0.getTime() + minutesAfterT0 * 60_000));

afterEach(() => {
  vi.useRealTimers();
  setSessionGate(null);
});

describe("absolute session lifetime", () => {
  it("defaults to 12 hours", () => {
    expect(DEFAULT_SESSION_MAX_SECONDS).toBe(12 * 3600);
  });

  it("carries the sign-in time and session id through a renewal; a renewal near the end is capped at 12 h after sign-in", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    at(0);
    const first = await mintSession(secret, user, { sid: "sid-1" });
    expect(first.signedAt).toBe(s(T0));
    at(11 * 60 + 59); // 11:59 after sign-in: renewing still works, but only to the 12 h mark
    const renewed = await mintSession(secret, user, { sid: "sid-1", signedAt: first.signedAt });
    expect(renewed.expiresAt).toBe(s(T0) + 12 * 3600);
    const v = await verifySession(secret, renewed.token);
    expect(v).toMatchObject({ id: user.id, signedAt: s(T0), sid: "sid-1", expiresAt: s(T0) + 12 * 3600 });
  });

  it("11:59 after sign-in a token is accepted; 12:01 it is refused, even one minted with a far expiry", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    at(11 * 60 + 30);
    // A renewal at 11:30 with a (wrongly) longer cap and life, verified with the 12 h one: only the limit can refuse it at 12:01.
    const t = await mintSession(secret, user, { sid: "sid-1", signedAt: s(T0), maxSessionSeconds: 24 * 3600, ttlSeconds: 7200 });
    at(11 * 60 + 59);
    await expect(verifySession(secret, t.token)).resolves.toMatchObject({ signedAt: s(T0) });
    at(12 * 60 + 1);
    await expect(verifySession(secret, t.token)).rejects.toThrow(/12 h|session limit/i);
  });

  it("a renewal can never extend past the limit: minting past it throws", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    at(12 * 60 + 1);
    await expect(mintSession(secret, user, { sid: "sid-1", signedAt: s(T0) })).rejects.toThrow(/session limit/i);
  });

  it("the limit is configurable (SESSION_MAX_HOURS)", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    at(0);
    const t = await mintSession(secret, user, { sid: "sid-1", maxSessionSeconds: 2 * 3600 });
    expect(t.expiresAt).toBe(s(T0) + 3600); // the usual hour, still inside 2 h
    at(59);
    const r = await mintSession(secret, user, { sid: "sid-1", signedAt: t.signedAt, maxSessionSeconds: 2 * 3600 });
    at(2 * 60 + 1);
    await expect(verifySession(secret, r.token, { maxSessionSeconds: 2 * 3600 })).rejects.toThrow();
    expect(authFromEnv({ LOCAL_ADMIN_ENABLED: "false", ENTRA_TENANT_ID: "t", AUTH_AUDIENCE: "a", SESSION_SECRET: secret, SESSION_MAX_HOURS: "2" }).session?.maxSessionSeconds).toBe(7200);
    expect(authFromEnv({ ENTRA_TENANT_ID: "t", AUTH_AUDIENCE: "a", SESSION_SECRET: secret }).session?.maxSessionSeconds).toBe(12 * 3600);
    expect(() => authFromEnv({ ENTRA_TENANT_ID: "t", AUTH_AUDIENCE: "a", SESSION_SECRET: secret, SESSION_MAX_HOURS: "0" })).toThrow(/SESSION_MAX_HOURS/);
    expect(() => authFromEnv({ ENTRA_TENANT_ID: "t", AUTH_AUDIENCE: "a", SESSION_SECRET: secret, SESSION_MAX_HOURS: "twelve" })).toThrow(/SESSION_MAX_HOURS/);
  });

  it("a token from before the deploy (no sign-in time, no session id) counts as signed in at its issue time", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    at(0);
    const { SignJWT } = await import("jose");
    const { localKey } = await import("./local");
    const legacy = await new SignJWT({ name: user.name, email: user.email, roles: user.roles })
      .setProtectedHeader({ alg: "HS256", typ: "JWT" })
      .setIssuer("gcpe-session")
      .setAudience("gcpe-session")
      .setSubject(user.id)
      .setIssuedAt(s(T0))
      .setExpirationTime(s(T0) + 3600)
      .sign(localKey(secret));
    at(30);
    const v = await verifySession(secret, legacy);
    expect(v.signedAt).toBe(s(T0));
    expect(v.sid).toBeUndefined();
  });
});

describe("requireBearer and the session gate", () => {
  const appWith = (session: Parameters<typeof requireBearer>[0]["session"]) => {
    const a = express();
    a.get("/x", requireBearer({ session }), (req, res) => void res.json({ auth: req.auth }));
    return a;
  };
  const cookie = (t: string) => `${SESSION_COOKIE}=${t}`;

  it("refuses with 401 and clears the cookie when the gate says the session is over", async () => {
    const { token } = await mintSession(secret, user, { sid: "sid-1" });
    const gate: SessionGate = async () => null;
    const res = await request(appWith({ secret, secure: true, gate })).get("/x").set("cookie", cookie(token));
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "not signed in" });
    expect(res.headers["set-cookie"]).toEqual(["gcpe_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0; Secure"]);
  });

  it("takes the current roles and name from the gate (a removed role is gone on the next request)", async () => {
    const { token } = await mintSession(secret, user, { sid: "sid-1" });
    const seen: unknown[] = [];
    const gate: SessionGate = async (v) => {
      seen.push({ id: v.id, sid: v.sid });
      return { ...user, name: "Renamed", roles: ["NRMS.Viewer"] };
    };
    const res = await request(appWith({ secret, gate })).get("/x").set("cookie", cookie(token));
    expect(res.status).toBe(200);
    expect(res.body.auth).toMatchObject({ subject: user.id, roles: ["NRMS.Viewer"], claims: { name: "Renamed", via: "session" } });
    expect(seen).toEqual([{ id: user.id, sid: "sid-1" }]);
  });

  it("an app with no gate of its own uses the one the stack installed (setSessionGate)", async () => {
    const { token } = await mintSession(secret, user, { sid: "sid-1" });
    const a = appWith({ secret });
    expect((await request(a).get("/x").set("cookie", cookie(token))).status).toBe(200);
    setSessionGate(async () => null);
    expect((await request(a).get("/x").set("cookie", cookie(token))).status).toBe(401);
    setSessionGate(null);
    expect((await request(a).get("/x").set("cookie", cookie(token))).status).toBe(200);
    // A stack shutting down removes only its own gate, never one a later stack installed.
    const removeFirst = setSessionGate(async () => null);
    setSessionGate(async () => user);
    removeFirst();
    expect((await request(a).get("/x").set("cookie", cookie(token))).status).toBe(200);
  });

  it("an invalid or over-the-limit cookie is refused with the cookie cleared too", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    at(11 * 60 + 30);
    const { token } = await mintSession(secret, user, { sid: "sid-1", signedAt: s(T0) });
    at(12 * 60 + 1);
    const res = await request(appWith({ secret, secure: false })).get("/x").set("cookie", cookie(token));
    expect(res.status).toBe(401);
    expect(res.headers["set-cookie"]).toEqual(["gcpe_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0"]);
  });

  it("a bearer token never goes through the gate", async () => {
    const { mintLocalToken } = await import("./local");
    const a = express();
    a.get("/x", requireBearer({ local: { secret }, session: { secret, gate: async () => null } }), (_req, res) => void res.json({ ok: true }));
    const bearer = await mintLocalToken({ secret, subject: "admin", roles: ["Core.Admin"] });
    expect((await request(a).get("/x").set("authorization", `Bearer ${bearer}`)).status).toBe(200);
  });
});

// Fix round 1 (review S I1, M4, M6).
describe("when the session check can't answer", () => {
  const appWith = (session: Parameters<typeof requireBearer>[0]["session"]) => {
    const a = express();
    a.get("/x", requireBearer({ session }), (req, res) => void res.json({ auth: req.auth }));
    return a;
  };
  const cookie = (t: string) => `${SESSION_COOKIE}=${t}`;

  it("a gate that fails answers 503 with Retry-After, keeps the cookie, and logs once per 30 seconds, not per request", async () => {
    const { token } = await mintSession(secret, user, { sid: "sid-1" });
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const a = appWith({ secret, gate: async () => Promise.reject(new Error("connection timeout")) });
      for (let i = 0; i < 3; i++) {
        const res = await request(a).get("/x").set("cookie", cookie(token));
        expect(res.status).toBe(503);
        expect(res.body).toEqual({ error: "sign-in check unavailable" });
        expect(res.headers["retry-after"]).toBe("5");
        expect(res.headers["set-cookie"]).toBeUndefined();
      }
      expect(errors.mock.calls.filter((c) => String(c[0]).includes("session check unavailable"))).toHaveLength(1);
    } finally {
      errors.mockRestore();
    }
  });

  it("an app the stack says must have a gate refuses with 503 while none is installed (never the signature alone)", async () => {
    const { token } = await mintSession(secret, user, { sid: "sid-1" });
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const a = appWith({ secret, gateRequired: true });
      expect((await request(a).get("/x").set("cookie", cookie(token))).status).toBe(503);
      setSessionGate(async () => user);
      expect((await request(a).get("/x").set("cookie", cookie(token))).status).toBe(200);
    } finally {
      errors.mockRestore();
    }
    expect(authFromEnv({ ENTRA_TENANT_ID: "t", AUTH_AUDIENCE: "a", SESSION_SECRET: secret, SESSION_GATE_REQUIRED: "true" }).bearer.session?.gateRequired).toBe(true);
    expect(authFromEnv({ ENTRA_TENANT_ID: "t", AUTH_AUDIENCE: "a", SESSION_SECRET: secret }).bearer.session?.gateRequired).toBe(false);
  });

  it("roles the gate vouched for are marked current; the token's own are not", async () => {
    const { token } = await mintSession(secret, user, { sid: "sid-1" });
    expect((await request(appWith({ secret, gate: async () => user })).get("/x").set("cookie", cookie(token))).body.auth.claims.rolesCurrent).toBe(true);
    expect((await request(appWith({ secret })).get("/x").set("cookie", cookie(token))).body.auth.claims.rolesCurrent).toBeUndefined();
  });

  it("minting past the limit throws a SessionLimitError a renewal can answer with 401", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    at(12 * 60);
    const { SessionLimitError } = await import("./session");
    await expect(mintSession(secret, user, { sid: "sid-1", signedAt: s(T0) })).rejects.toBeInstanceOf(SessionLimitError);
  });
});

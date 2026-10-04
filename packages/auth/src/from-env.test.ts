import express from "express";
import request from "supertest";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { requireBearer } from "./bearer";
import { authFromEnv } from "./from-env";
import { mintLocalToken } from "./local";
import { hashPassword } from "./password";

const secret = "x".repeat(32);
// A real hash (not a hand-typed fixture) so it satisfies the scrypt parameter/salt/key
// bounds enforced by parsePasswordHash — see fix round 1, Important #6.
let hash: string;

describe("authFromEnv", () => {
  beforeAll(async () => {
    hash = await hashPassword("fixture-password-for-from-env-tests");
  });

  it("throws when neither Entra nor local admin is configured", () => {
    expect(() => authFromEnv({})).toThrow(/ENTRA_TENANT_ID.*LOCAL_ADMIN_ENABLED/s);
  });
  it("throws when only one of ENTRA_TENANT_ID / AUTH_AUDIENCE is set", () => {
    expect(() => authFromEnv({ ENTRA_TENANT_ID: "t" })).toThrow(/AUTH_AUDIENCE/);
  });
  it("enables local admin only with a valid hash and a long secret", () => {
    expect(() => authFromEnv({ LOCAL_ADMIN_ENABLED: "true", LOCAL_ADMIN_PASSWORD_HASH: "plain", LOCAL_AUTH_SECRET: secret })).toThrow(/LOCAL_ADMIN_PASSWORD_HASH/);
    expect(() => authFromEnv({ LOCAL_ADMIN_ENABLED: "true", LOCAL_ADMIN_PASSWORD_HASH: hash, LOCAL_AUTH_SECRET: "short" })).toThrow(/LOCAL_AUTH_SECRET/);
    const a = authFromEnv({ LOCAL_ADMIN_ENABLED: "true", LOCAL_ADMIN_PASSWORD_HASH: hash, LOCAL_AUTH_SECRET: secret });
    expect(a.local).toEqual({ username: "admin", passwordHash: hash, secret });
    expect(a.loginRouter).not.toBeNull();
    expect(a.bearer.local).toEqual({ secret });
  });
  it('treats LOCAL_ADMIN_ENABLED="false" as disabled', () => {
    expect(() => authFromEnv({ LOCAL_ADMIN_ENABLED: "false", LOCAL_ADMIN_PASSWORD_HASH: hash, LOCAL_AUTH_SECRET: secret })).toThrow();
  });
  it("Entra only: no login router", () => {
    const a = authFromEnv({ ENTRA_TENANT_ID: "t", AUTH_AUDIENCE: "api://core" });
    expect(a.loginRouter).toBeNull();
    expect(a.bearer).toMatchObject({ issuer: "https://login.microsoftonline.com/t/v2.0", audience: "api://core" });
  });
  // Security rule 5: enabling local admin must announce itself loudly at startup.
  it("logs a loud warning on startup when (and only when) local admin is enabled", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      authFromEnv({ ENTRA_TENANT_ID: "t", AUTH_AUDIENCE: "api://core" });
      expect(warn).not.toHaveBeenCalled();
      authFromEnv({ LOCAL_ADMIN_ENABLED: "true", LOCAL_ADMIN_PASSWORD_HASH: hash, LOCAL_AUTH_SECRET: secret });
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("LOCAL ADMIN LOGIN ENABLED"));
    } finally {
      warn.mockRestore();
    }
  });

  // Fix round 1, Important #1: Entra configured, with a local admin hash/secret sitting
  // unused in the env (e.g. left over from another environment's config), but local admin
  // not actually enabled -- must never leak a local verifier into `bearer`, and a
  // perfectly valid local token must still be rejected by the resulting middleware.
  it.each([
    ["LOCAL_ADMIN_ENABLED unset", {}],
    ['LOCAL_ADMIN_ENABLED="false"', { LOCAL_ADMIN_ENABLED: "false" }],
  ] as const)("Entra + unused local admin env vars, %s: local stays off end to end", async (_label, extra) => {
    const a = authFromEnv({
      ENTRA_TENANT_ID: "t",
      AUTH_AUDIENCE: "api://core",
      LOCAL_ADMIN_PASSWORD_HASH: hash,
      LOCAL_AUTH_SECRET: secret,
      ...extra,
    });
    expect(a.bearer.local).toBeUndefined();
    expect(a.loginRouter).toBeNull();
    expect(a.local).toBeNull();

    const app = express();
    app.get("/x", requireBearer(a.bearer), (_req, res) => void res.json({ ok: true }));
    const token = await mintLocalToken({ secret, subject: "admin", roles: ["Core.Admin"] });
    const res = await request(app).get("/x").set("authorization", `Bearer ${token}`);
    expect(res.status).toBe(401);
  });

  // Fix round 1, Important #6: the stored hash's own scrypt cost parameters are policed at
  // startup, not just its shape -- a tampered/corrupted hash with nonsensical parameters
  // must fail loudly instead of silently verifying (or worse, DoS-ing the process).
  it("rejects a startup hash whose N is not a safe power of two", async () => {
    const parts = hash.split("$");
    parts[1] = "3";
    const bad = parts.join("$");
    let threw: unknown;
    try {
      authFromEnv({ LOCAL_ADMIN_ENABLED: "true", LOCAL_ADMIN_PASSWORD_HASH: bad, LOCAL_AUTH_SECRET: secret });
    } catch (err) {
      threw = err;
    }
    expect(String(threw)).toContain("LOCAL_ADMIN_PASSWORD_HASH");
    expect(String(threw)).not.toContain(bad); // the message names the var, never echoes the secret-bearing value
  });
  it("rejects a startup hash whose p exceeds the allowed range", async () => {
    const parts = hash.split("$");
    parts[3] = "2048";
    const bad = parts.join("$");
    expect(() => authFromEnv({ LOCAL_ADMIN_ENABLED: "true", LOCAL_ADMIN_PASSWORD_HASH: bad, LOCAL_AUTH_SECRET: secret })).toThrow(/LOCAL_ADMIN_PASSWORD_HASH/);
  });

  // Fix round 1, Minor #8: production guard.
  describe("production guard", () => {
    it("refuses LOCAL_ADMIN_ENABLED=true when NODE_ENV=production without the override", () => {
      expect(() =>
        authFromEnv({ NODE_ENV: "production", LOCAL_ADMIN_ENABLED: "true", LOCAL_ADMIN_PASSWORD_HASH: hash, LOCAL_AUTH_SECRET: secret }),
      ).toThrow(/production/i);
    });
    it("allows it in production when LOCAL_ADMIN_ALLOW_IN_PRODUCTION=true", () => {
      const a = authFromEnv({
        NODE_ENV: "production",
        LOCAL_ADMIN_ENABLED: "true",
        LOCAL_ADMIN_ALLOW_IN_PRODUCTION: "true",
        LOCAL_ADMIN_PASSWORD_HASH: hash,
        LOCAL_AUTH_SECRET: secret,
      });
      expect(a.local).not.toBeNull();
    });
    it("never triggers outside production", () => {
      const a = authFromEnv({ NODE_ENV: "development", LOCAL_ADMIN_ENABLED: "true", LOCAL_ADMIN_PASSWORD_HASH: hash, LOCAL_AUTH_SECRET: secret });
      expect(a.local).not.toBeNull();
    });
  });

  it("reads SESSION_SECRET (>= 32 chars) into bearer.session and session", async () => {
    const base = { LOCAL_ADMIN_ENABLED: "true", LOCAL_ADMIN_PASSWORD_HASH: await hashPassword("a-long-enough-password"), LOCAL_AUTH_SECRET: "l".repeat(40) };
    expect(authFromEnv(base).session).toBeNull();
    const withSession = authFromEnv({ ...base, SESSION_SECRET: "x".repeat(40) });
    expect(withSession.session).toEqual({ secret: "x".repeat(40) });
    expect(withSession.bearer.session).toEqual({ secret: "x".repeat(40) });
    expect(() => authFromEnv({ ...base, SESSION_SECRET: "short" })).toThrow(/SESSION_SECRET must be at least 32 characters/);
  });
});

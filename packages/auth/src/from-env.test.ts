import { describe, expect, it, vi } from "vitest";
import { authFromEnv } from "./from-env";
const hash = "scrypt$16384$8$1$c2FsdA$aGFzaA";
const secret = "x".repeat(32);
describe("authFromEnv", () => {
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
});

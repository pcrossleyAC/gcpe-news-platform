import { describe, expect, it } from "vitest";
import { signInSettingsFromEnv } from "./config";

const TENANT = "0000fa4e-0000-4000-8000-000000000002";
const FULL = {
  ENTRA_TENANT_ID: TENANT,
  ENTRA_CLIENT_ID: "core-client",
  ENTRA_CLIENT_SECRET: "core-secret",
  PUBLIC_BASE_URL: "https://news.example.test",
  SESSION_SECRET: "s".repeat(32),
};

describe("signInSettingsFromEnv", () => {
  it("is off with none of the settings, and with ENTRA_TENANT_ID alone (service tokens only)", () => {
    expect(signInSettingsFromEnv({})).toEqual({ entra: null, userPasswordsAllowed: true });
    expect(signInSettingsFromEnv({ ENTRA_TENANT_ID: TENANT, NODE_ENV: "production" })).toEqual({ entra: null, userPasswordsAllowed: true });
  });

  it("is on with every setting, using Microsoft's v2.0 authority and the callback under PUBLIC_BASE_URL", () => {
    expect(signInSettingsFromEnv(FULL).entra).toEqual({
      tenantId: TENANT,
      clientId: "core-client",
      clientSecret: "core-secret",
      authority: `https://login.microsoftonline.com/${TENANT}/v2.0`,
      redirectUri: "https://news.example.test/core/auth/entra/callback",
    });
    expect(signInSettingsFromEnv({ ...FULL, PUBLIC_BASE_URL: "https://news.example.test/" }).entra!.redirectUri).toBe("https://news.example.test/core/auth/entra/callback");
  });

  it.each([
    [{ ENTRA_CLIENT_ID: "core-client" }, "missing ENTRA_TENANT_ID, ENTRA_CLIENT_SECRET, PUBLIC_BASE_URL, SESSION_SECRET"],
    [{ ...FULL, ENTRA_CLIENT_SECRET: undefined }, "missing ENTRA_CLIENT_SECRET"],
    [{ ...FULL, PUBLIC_BASE_URL: "" }, "missing PUBLIC_BASE_URL"],
    [{ ...FULL, ENTRA_TENANT_ID: undefined }, "missing ENTRA_TENANT_ID"],
    [{ ...FULL, SESSION_SECRET: undefined }, "missing SESSION_SECRET"],
  ])("a partial configuration fails, naming what's missing (%#)", (env, message) => {
    expect(() => signInSettingsFromEnv(env)).toThrow(`Entra sign-in is partly configured: ${message}`);
  });

  it.each([
    ["not a URL", "news.example.test"],
    ["a path", "https://news.example.test/hub"],
    ["plain http off localhost", "http://news.example.test"],
  ])("refuses a PUBLIC_BASE_URL with %s", (_label, value) => {
    expect(() => signInSettingsFromEnv({ ...FULL, PUBLIC_BASE_URL: value })).toThrow(/PUBLIC_BASE_URL/);
  });

  it("allows http for localhost", () => {
    expect(signInSettingsFromEnv({ ...FULL, PUBLIC_BASE_URL: "http://127.0.0.1:4100" }).entra!.redirectUri).toBe("http://127.0.0.1:4100/core/auth/entra/callback");
  });

  it("production refuses user passwords when Entra is on, unless LOCAL_PASSWORDS_ALLOWED=true", () => {
    expect(signInSettingsFromEnv({ ...FULL, NODE_ENV: "production" }).userPasswordsAllowed).toBe(false);
    expect(signInSettingsFromEnv({ ...FULL, NODE_ENV: "production", LOCAL_PASSWORDS_ALLOWED: "false" }).userPasswordsAllowed).toBe(false);
    expect(signInSettingsFromEnv({ ...FULL, NODE_ENV: "production", LOCAL_PASSWORDS_ALLOWED: "true" }).userPasswordsAllowed).toBe(true);
    expect(signInSettingsFromEnv({ NODE_ENV: "production" }).userPasswordsAllowed).toBe(true);
    expect(signInSettingsFromEnv({ ...FULL, NODE_ENV: "test" }).userPasswordsAllowed).toBe(true);
    expect(() => signInSettingsFromEnv({ LOCAL_PASSWORDS_ALLOWED: "yes" })).toThrow('LOCAL_PASSWORDS_ALLOWED must be "true" or "false"');
  });

  it("ENTRA_AUTHORITY_URL points a test site at the fake, and is refused in production or on its own", () => {
    const fake = "http://stack.internal/fake-entra/0000fa4e/v2.0";
    expect(signInSettingsFromEnv({ ...FULL, NODE_ENV: "test", ENTRA_AUTHORITY_URL: `${fake}/` }).entra!.authority).toBe(fake);
    expect(signInSettingsFromEnv({ ...FULL, NODE_ENV: "production", LOCAL_ADMIN_ALLOW_IN_PRODUCTION: "true", ENTRA_AUTHORITY_URL: fake }).entra!.authority).toBe(fake);
    expect(() => signInSettingsFromEnv({ ...FULL, NODE_ENV: "production", ENTRA_AUTHORITY_URL: fake })).toThrow("ENTRA_AUTHORITY_URL is for test sites only");
    expect(() => signInSettingsFromEnv({ ENTRA_AUTHORITY_URL: fake })).toThrow("ENTRA_AUTHORITY_URL is set but Entra sign-in is not");
  });
});

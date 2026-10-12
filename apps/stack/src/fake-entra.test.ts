import { describe, expect, it } from "vitest";
import { authFromEnv } from "@gcpe/auth";
import { signInSettingsFromEnv } from "../../core/src/entra/config";
import { envFor, FAKE_ENTRA, FAKE_ENTRA_PATH, resolveSelfUrls, usesFakeEntra } from "./env";

const ON = { FAKE_ENTRA_ENABLED: "true", CORE_PUBLIC_BASE_URL: "https://boxs.example.test", STACK_EVENT_SECRET: "e".repeat(40), LOCAL_ADMIN_ENABLED: "true" };

describe("fake Microsoft sign-in", () => {
  it("is off unless FAKE_ENTRA_ENABLED=true, and then Core's view carries nothing of it", () => {
    expect(usesFakeEntra({})).toBe(false);
    expect(usesFakeEntra({ FAKE_ENTRA_ENABLED: "1" })).toBe(false);
    expect(envFor({}, "CORE").ENTRA_CLIENT_ID).toBeUndefined();
    expect(envFor({}, "CORE").ENTRA_TENANT_ID).toBeUndefined();
  });

  it("points Core, and only Core, at the in-process fake", () => {
    const core = resolveSelfUrls(envFor(ON, "CORE"));
    expect(core).toMatchObject({
      ENTRA_TENANT_ID: FAKE_ENTRA.tenantId,
      AUTH_AUDIENCE: FAKE_ENTRA.audience,
      ENTRA_CLIENT_ID: FAKE_ENTRA.clientId,
      ENTRA_AUTHORITY_URL: `http://stack.internal${FAKE_ENTRA_PATH}/${FAKE_ENTRA.tenantId}/v2.0`,
      PUBLIC_BASE_URL: "https://boxs.example.test",
    });
    expect(signInSettingsFromEnv(core).entra).toMatchObject({ authority: `http://stack.internal${FAKE_ENTRA_PATH}/${FAKE_ENTRA.tenantId}/v2.0`, redirectUri: "https://boxs.example.test/core/auth/entra/callback" });
    expect(() => authFromEnv({ ...core, LOCAL_ADMIN_PASSWORD_HASH: undefined, LOCAL_ADMIN_ENABLED: "false" })).not.toThrow();
    for (const prefix of ["NRMS", "NEWSAPI", "SITE", "NOD", "DIST", "CALENDAR"] as const) {
      expect(envFor(ON, prefix).ENTRA_TENANT_ID, prefix).toBeUndefined();
      expect(envFor(ON, prefix).ENTRA_CLIENT_ID, prefix).toBeUndefined();
    }
  });

  it("is refused on a real production deployment, allowed on a production-mode test site", () => {
    expect(() => usesFakeEntra({ ...ON, NODE_ENV: "production" })).toThrow("FAKE_ENTRA_ENABLED is refused on a production deployment");
    expect(usesFakeEntra({ ...ON, NODE_ENV: "production", LOCAL_ADMIN_ALLOW_IN_PRODUCTION: "true" })).toBe(true);
  });

  it("can't be combined with real Entra settings", () => {
    expect(() => usesFakeEntra({ ...ON, ENTRA_TENANT_ID: "0000fa4e-0000-4000-8000-0000000000aa" })).toThrow("FAKE_ENTRA_ENABLED can't be combined with real Entra settings (ENTRA_TENANT_ID)");
    expect(() => usesFakeEntra({ ...ON, CORE_ENTRA_CLIENT_ID: "real" })).toThrow("(CORE_ENTRA_CLIENT_ID)");
  });
});

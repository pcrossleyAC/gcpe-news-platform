import { describe, expect, it } from "vitest";
import { clearedEntraStateCookie, entraStateCookie, openEntraState, sealEntraState } from "./state-cookie";

const SECRET = "x".repeat(40);
const VALUE = { state: "st", nonce: "nn", codeVerifier: "cv", returnTo: "/hub/releases/drafts" };

describe("gcpe_entra state cookie", () => {
  it("round-trips within five minutes and expires after", () => {
    const now = Date.UTC(2026, 9, 12, 12, 0, 0);
    const sealed = sealEntraState(SECRET, VALUE, now);
    expect(openEntraState(SECRET, sealed, now + 299_000)).toEqual(VALUE);
    expect(openEntraState(SECRET, sealed, now + 300_000)).toBeNull();
  });

  it("refuses a missing, tampered, re-signed-with-another-secret or malformed value", () => {
    const sealed = sealEntraState(SECRET, VALUE);
    const [body, sig] = sealed.split(".") as [string, string];
    const forged = Buffer.from(JSON.stringify({ ...VALUE, returnTo: "/hub/other", exp: 9_999_999_999 })).toString("base64url");
    expect(openEntraState(SECRET, undefined)).toBeNull();
    expect(openEntraState(SECRET, `${forged}.${sig}`)).toBeNull();
    expect(openEntraState("y".repeat(40), sealed)).toBeNull();
    expect(openEntraState(SECRET, body)).toBeNull();
    expect(openEntraState(SECRET, `${body}.${sig}.extra`)).toBeNull();
  });

  it("refuses a validly signed value missing a field", () => {
    expect(openEntraState(SECRET, sealEntraState(SECRET, { ...VALUE, codeVerifier: "" }))).toBeNull();
  });

  it("is HttpOnly, SameSite=Lax, scoped to /core/auth/entra, five minutes, Secure when asked", () => {
    expect(entraStateCookie("v", { secure: true })).toBe("gcpe_entra=v; Path=/core/auth/entra; HttpOnly; SameSite=Lax; Max-Age=300; Secure");
    expect(entraStateCookie("v", { secure: false })).toBe("gcpe_entra=v; Path=/core/auth/entra; HttpOnly; SameSite=Lax; Max-Age=300");
    expect(clearedEntraStateCookie({ secure: true })).toBe("gcpe_entra=; Path=/core/auth/entra; HttpOnly; SameSite=Lax; Max-Age=0; Secure");
  });
});

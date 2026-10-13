import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * The `gcpe_entra` cookie: the state, nonce, PKCE verifier and
 * return path of one sign-in, carried by the browser from GET /core/auth/entra to the callback,
 * so any replica can finish the flow. HMAC-signed with a key derived from SESSION_SECRET, never
 * the secret itself, so it can't be confused with a session token.
 */
export const ENTRA_STATE_COOKIE = "gcpe_entra";
export const ENTRA_STATE_PATH = "/core/auth/entra";
export const ENTRA_STATE_TTL_SECONDS = 5 * 60;

export interface EntraFlowState {
  state: string;
  nonce: string;
  codeVerifier: string;
  returnTo: string;
}

const keyFor = (secret: string) => createHmac("sha256", secret).update("gcpe-entra-state").digest();
const mac = (secret: string, body: string) => createHmac("sha256", keyFor(secret)).update(body).digest("base64url");
const nonEmpty = (v: unknown): v is string => typeof v === "string" && v.length > 0;

export function sealEntraState(secret: string, value: EntraFlowState, now = Date.now()): string {
  const body = Buffer.from(JSON.stringify({ ...value, exp: Math.floor(now / 1000) + ENTRA_STATE_TTL_SECONDS })).toString("base64url");
  return `${body}.${mac(secret, body)}`;
}

/** The sealed state, or null when it's missing, tampered with, malformed or expired. */
export function openEntraState(secret: string, raw: string | undefined, now = Date.now()): EntraFlowState | null {
  if (!raw) return null;
  const parts = raw.split(".");
  if (parts.length !== 2) return null;
  const [body, sig] = parts as [string, string];
  const given = Buffer.from(sig);
  const expected = Buffer.from(mac(secret, body));
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  let v: Record<string, unknown>;
  try {
    v = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (typeof v.exp !== "number" || v.exp * 1000 <= now) return null;
  if (!nonEmpty(v.state) || !nonEmpty(v.nonce) || !nonEmpty(v.codeVerifier) || !nonEmpty(v.returnTo)) return null;
  return { state: v.state, nonce: v.nonce, codeVerifier: v.codeVerifier, returnTo: v.returnTo };
}

export function entraStateCookie(value: string, opts: { secure: boolean }): string {
  return [`${ENTRA_STATE_COOKIE}=${value}`, `Path=${ENTRA_STATE_PATH}`, "HttpOnly", "SameSite=Lax", `Max-Age=${ENTRA_STATE_TTL_SECONDS}`, ...(opts.secure ? ["Secure"] : [])].join("; ");
}

export function clearedEntraStateCookie(opts: { secure: boolean }): string {
  return [`${ENTRA_STATE_COOKIE}=`, `Path=${ENTRA_STATE_PATH}`, "HttpOnly", "SameSite=Lax", "Max-Age=0", ...(opts.secure ? ["Secure"] : [])].join("; ");
}

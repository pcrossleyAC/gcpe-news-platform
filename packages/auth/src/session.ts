import { jwtVerify, SignJWT } from "jose";
import { assertSecretStrength, localKey } from "./local";

/**
 * Staff session (spec addendum §2): Core signs one token per sign-in and sets it as an
 * HttpOnly cookie for the whole site; every app's API accepts it (see requireBearer). The
 * issuer/audience differ from the local-admin bearer token's, so neither token can be replayed
 * as the other even when the same secret is configured for both.
 */
export const SESSION_COOKIE = "gcpe_session";
export const SESSION_ISSUER = "gcpe-session";
export const SESSION_TTL_SECONDS = 60 * 60;
/** /core/auth/session reissues the cookie once this little lifetime remains. */
export const SESSION_RENEW_WINDOW_SECONDS = 15 * 60;
/** Required (value "1") on every state-changing request authenticated by the cookie: a
 * cross-site form can't set a custom header, so this plus SameSite=Lax blocks CSRF. */
export const CSRF_HEADER = "x-gcpe-request";

/** Owner decision 2026-10-31: a session lasts at most this long from sign-in, whatever the
 * renewals (SESSION_MAX_HOURS overrides it, the same value for every app). */
export const DEFAULT_SESSION_MAX_SECONDS = 12 * 60 * 60;

export interface SessionUser {
  id: string;
  name: string;
  email: string;
  roles: string[];
}

export interface VerifiedSession extends SessionUser {
  /** Unix seconds. */
  expiresAt: number;
  /** When the person signed in (Unix seconds): the token's `sat`, carried through every renewal.
   * A token from before the 12-hour limit has none and counts from its own `iat`. */
  signedAt: number;
  /** Core's id for this sign-in (`sid`), the same across renewals; the session gate looks it up.
   * Absent on a token from before the limit. */
  sid?: string;
}

export interface MintSessionOptions {
  /** This token's own life, at most; default an hour. */
  ttlSeconds?: number;
  /** A renewal passes the original sign-in time on; a sign-in leaves it out (now). */
  signedAt?: number;
  sid?: string;
  maxSessionSeconds?: number;
}

/** `opts` as a number is the old `ttlSeconds` argument. The expiry never goes past sign-in + the
 * limit; minting once the limit has passed throws (a renewal must refuse instead). */
export async function mintSession(
  secret: string,
  user: SessionUser,
  opts: number | MintSessionOptions = {},
): Promise<{ token: string; expiresAt: number; signedAt: number }> {
  assertSecretStrength(secret);
  const o = typeof opts === "number" ? { ttlSeconds: opts } : opts;
  const now = Math.floor(Date.now() / 1000);
  const signedAt = o.signedAt ?? now;
  const limit = signedAt + (o.maxSessionSeconds ?? DEFAULT_SESSION_MAX_SECONDS);
  if (limit <= now) throw new Error("the session limit has passed: sign in again");
  const expiresAt = Math.min(now + (o.ttlSeconds ?? SESSION_TTL_SECONDS), limit);
  const token = await new SignJWT({ name: user.name, email: user.email, roles: [...user.roles], sat: signedAt, ...(o.sid ? { sid: o.sid } : {}) })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuer(SESSION_ISSUER)
    .setAudience(SESSION_ISSUER)
    .setSubject(user.id)
    .setIssuedAt(now)
    .setExpirationTime(expiresAt)
    .sign(localKey(secret));
  return { token, expiresAt, signedAt };
}

export async function verifySession(secret: string, token: string, opts: { maxSessionSeconds?: number } = {}): Promise<VerifiedSession> {
  const { payload } = await jwtVerify(token, localKey(secret), {
    issuer: SESSION_ISSUER,
    audience: SESSION_ISSUER,
    algorithms: ["HS256"],
    requiredClaims: ["exp", "iat", "sub"],
    maxTokenAge: `${SESSION_TTL_SECONDS}s`,
  });
  const now = Math.floor(Date.now() / 1000);
  const signedAt = typeof payload.sat === "number" ? payload.sat : payload.iat!;
  // A sign-in time later than the token's own issue can't come from Core: refuse it.
  if (signedAt > payload.iat!) throw new Error("invalid session: signed in after issue");
  if (now >= signedAt + (opts.maxSessionSeconds ?? DEFAULT_SESSION_MAX_SECONDS)) throw new Error("the session limit has passed: sign in again");
  return {
    id: String(payload.sub),
    name: typeof payload.name === "string" ? payload.name : String(payload.sub),
    email: typeof payload.email === "string" ? payload.email : "",
    roles: Array.isArray(payload.roles) ? payload.roles.map(String) : [],
    expiresAt: payload.exp!,
    signedAt,
    ...(typeof payload.sid === "string" && payload.sid ? { sid: payload.sid } : {}),
  };
}

export function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return undefined;
}

export function sessionCookie(token: string, opts: { secure: boolean; maxAgeSeconds: number }): string {
  return [`${SESSION_COOKIE}=${token}`, "Path=/", "HttpOnly", "SameSite=Lax", `Max-Age=${opts.maxAgeSeconds}`, ...(opts.secure ? ["Secure"] : [])].join("; ");
}

export function clearedSessionCookie(opts: { secure: boolean }): string {
  return sessionCookie("", { ...opts, maxAgeSeconds: 0 });
}

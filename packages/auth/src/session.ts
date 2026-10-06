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

export interface SessionUser {
  id: string;
  name: string;
  email: string;
  roles: string[];
}

export interface VerifiedSession extends SessionUser {
  /** Unix seconds. */
  expiresAt: number;
}

export async function mintSession(secret: string, user: SessionUser, ttlSeconds = SESSION_TTL_SECONDS): Promise<{ token: string; expiresAt: number }> {
  assertSecretStrength(secret);
  const now = Math.floor(Date.now() / 1000);
  const expiresAt = now + ttlSeconds;
  const token = await new SignJWT({ name: user.name, email: user.email, roles: [...user.roles] })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuer(SESSION_ISSUER)
    .setAudience(SESSION_ISSUER)
    .setSubject(user.id)
    .setIssuedAt(now)
    .setExpirationTime(expiresAt)
    .sign(localKey(secret));
  return { token, expiresAt };
}

export async function verifySession(secret: string, token: string): Promise<VerifiedSession> {
  const { payload } = await jwtVerify(token, localKey(secret), {
    issuer: SESSION_ISSUER,
    audience: SESSION_ISSUER,
    algorithms: ["HS256"],
    requiredClaims: ["exp", "iat", "sub"],
    maxTokenAge: `${SESSION_TTL_SECONDS}s`,
  });
  return {
    id: String(payload.sub),
    name: typeof payload.name === "string" ? payload.name : String(payload.sub),
    email: typeof payload.email === "string" ? payload.email : "",
    roles: Array.isArray(payload.roles) ? payload.roles.map(String) : [],
    expiresAt: payload.exp!,
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

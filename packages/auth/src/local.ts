import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import express, { Router } from "express";
import rateLimit from "express-rate-limit";
import { jwtVerify, SignJWT, type JWTPayload } from "jose";
import { verifyPassword } from "./password";

export const LOCAL_ISSUER = "gcpe-local";
export const LOCAL_AUDIENCE = "gcpe-local";
export const ADMIN_ROLES = ["Core.Admin", "NRMS.Editor", "NRMS.SiteEditor", "NoD.Admin", "Distribution.Send"] as const;
const DEFAULT_TTL = 8 * 60 * 60;
/** The break-glass admin's id in Core's sign-in records and session gate (it has no users row). */
export const BREAK_GLASS_ID = "local:admin";
/** A break-glass bearer token lasts at most this long, and never longer than SESSION_MAX_HOURS. */
export const BREAK_GLASS_TOKEN_MAX_SECONDS = DEFAULT_TTL;
const MIN_SECRET_LENGTH = 32;

export interface LocalAuthConfig {
  username: string;
  passwordHash: string;
  secret: string;
}

export const localKey = (secret: string) => new TextEncoder().encode(secret);

/** Shared by `mintLocalToken` and `requireBearer` so a weak secret fails the same way at either edge. */
export function assertSecretStrength(secret: string): void {
  if (secret.length < MIN_SECRET_LENGTH) throw new Error(`local auth secret must be at least ${MIN_SECRET_LENGTH} characters`);
}

export async function mintLocalToken(o: {
  secret: string;
  subject: string;
  roles: readonly string[];
  azp?: string;
  ttlSeconds?: number;
  /** Further claims (the break-glass login's `bg`, `sid` and `pwf`). */
  claims?: Record<string, unknown>;
  /** Clock override for tests (e.g. serviceTokenProvider's re-mint-after-expiry case, where a
   * fixed wall clock would otherwise mint byte-identical tokens for the same claims); defaults
   * to the wall clock. */
  now?: () => number;
}): Promise<string> {
  assertSecretStrength(o.secret);
  const now = Math.floor((o.now ?? Date.now)() / 1000);
  return new SignJWT({ ...o.claims, roles: [...o.roles], ...(o.azp ? { azp: o.azp } : {}) })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuer(LOCAL_ISSUER)
    .setAudience(LOCAL_AUDIENCE)
    .setSubject(o.subject)
    .setIssuedAt(now)
    .setExpirationTime(now + (o.ttlSeconds ?? DEFAULT_TTL))
    .sign(localKey(o.secret));
}

/**
 * Owner decision 2026-10-31 (review S M8): what a break-glass bearer token is checked against on
 * every request, so it stops working when the password changes (its fingerprint no longer
 * matches), past min(8 h, SESSION_MAX_HOURS), and once signed out (Core's session gate, by the
 * token's own `sid`). Turning break-glass off removes the local verifier altogether.
 */
export interface BreakGlassCheck {
  username: string;
  passwordHash: string;
  /** SESSION_MAX_HOURS, in seconds; default 12 hours (so the 8 h cap applies). */
  maxSessionSeconds?: number;
  /** The stack's SESSION_GATE_REQUIRED: with no session gate installed, refuse (503) rather than skip the sign-out check. */
  gateRequired?: boolean;
}

/** How long a break-glass token lasts: min(8 h, the session limit). */
export function breakGlassTokenSeconds(maxSessionSeconds?: number): number {
  return Math.min(BREAK_GLASS_TOKEN_MAX_SECONDS, maxSessionSeconds ?? BREAK_GLASS_TOKEN_MAX_SECONDS);
}

/**
 * A fingerprint of the current break-glass password for the token's `pwf` claim: an HMAC of the
 * stored (salted scrypt) hash under LOCAL_AUTH_SECRET. It changes whenever the password (so the
 * hash) changes, and reveals neither: without the secret it can't even be compared to a hash.
 */
export function breakGlassFingerprint(secret: string, passwordHash: string): string {
  return createHmac("sha256", secret).update(`gcpe-break-glass-password:${passwordHash}`).digest("base64url").slice(0, 32);
}

/** Whether a token's `pwf` claim matches the current password's fingerprint (constant time). */
export function fingerprintMatches(claim: unknown, expected: string): boolean {
  if (typeof claim !== "string") return false;
  const a = Buffer.from(claim);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * The break-glass checks on a verified local token marked `bg`: the password fingerprint still
 * matches and it is younger than min(8 h, the session limit). Returns its `sid`; throws otherwise.
 * (Sign-out is Core's session gate, run by requireBearer.)
 */
export function breakGlassSid(payload: JWTPayload, expected: { fingerprint: string; maxAgeSeconds: number }): string {
  if (!fingerprintMatches(payload.pwf, expected.fingerprint)) throw new Error("break-glass token: the password has changed");
  if (typeof payload.sid !== "string" || !payload.sid) throw new Error("break-glass token without a sign-in id");
  if (typeof payload.iat !== "number" || Math.floor(Date.now() / 1000) - payload.iat >= expected.maxAgeSeconds) throw new Error("break-glass token past its limit");
  return payload.sid;
}

/** Verifies a break-glass bearer token on its own (Core's Sign out for one): signature, expiry and
 * the checks in {@link breakGlassSid}. */
export async function verifyBreakGlassToken(token: string, secret: string, check: BreakGlassCheck): Promise<{ sid: string; subject: string }> {
  const { payload } = await jwtVerify(token, localKey(secret), { issuer: LOCAL_ISSUER, audience: LOCAL_AUDIENCE, algorithms: ["HS256"], requiredClaims: ["exp", "iat", "sub"] });
  if (payload.bg !== true) throw new Error("not a break-glass token");
  const sid = breakGlassSid(payload, { fingerprint: breakGlassFingerprint(secret, check.passwordHash), maxAgeSeconds: breakGlassTokenSeconds(check.maxSessionSeconds) });
  return { sid, subject: String(payload.sub) };
}

export function localLoginRouter(
  cfg: LocalAuthConfig,
  opts: { ratePerMinute?: number; verify?: typeof verifyPassword; /** SESSION_MAX_HOURS, in seconds. */ maxSessionSeconds?: number } = {},
): Router {
  const ttlSeconds = breakGlassTokenSeconds(opts.maxSessionSeconds);
  const verify = opts.verify ?? verifyPassword;
  const r = Router();
  r.post(
    "/auth/local/token",
    rateLimit({ windowMs: 60_000, limit: opts.ratePerMinute ?? 10, standardHeaders: "draft-7", legacyHeaders: false }),
    express.json({ limit: "1kb" }),
    async (req, res) => {
      const { username, password } = (req.body ?? {}) as { username?: unknown; password?: unknown };
      const pw = typeof password === "string" ? password : "";
      // Always run exactly one hash comparison, even for an unknown username, so a wrong
      // username costs the same as a wrong password (no early-exit timing tell).
      const passwordOk = await verify(pw, cfg.passwordHash);
      if (username !== cfg.username || !passwordOk) return void res.status(401).json({ error: "invalid credentials" });
      // `bg` marks it break-glass (checked by requireBearer: fingerprint, age, sign-out); `sid` is
      // this token's own sign-in for Core's session gate, recorded only if it is signed out.
      const access_token = await mintLocalToken({
        secret: cfg.secret,
        subject: cfg.username,
        roles: ADMIN_ROLES,
        ttlSeconds,
        claims: { bg: true, sid: randomBytes(18).toString("base64url"), pwf: breakGlassFingerprint(cfg.secret, cfg.passwordHash) },
      });
      res.json({ access_token, token_type: "Bearer", expires_in: ttlSeconds });
    },
  );
  return r;
}

import express, { Router } from "express";
import rateLimit from "express-rate-limit";
import { SignJWT } from "jose";
import { verifyPassword } from "./password";

export const LOCAL_ISSUER = "gcpe-local";
export const LOCAL_AUDIENCE = "gcpe-local";
export const ADMIN_ROLES = ["Core.Admin", "NRMS.Editor", "NRMS.SiteEditor", "NoD.Admin", "Distribution.Send"] as const;
const DEFAULT_TTL = 8 * 60 * 60;
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
}): Promise<string> {
  assertSecretStrength(o.secret);
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ roles: [...o.roles], ...(o.azp ? { azp: o.azp } : {}) })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuer(LOCAL_ISSUER)
    .setAudience(LOCAL_AUDIENCE)
    .setSubject(o.subject)
    .setIssuedAt(now)
    .setExpirationTime(now + (o.ttlSeconds ?? DEFAULT_TTL))
    .sign(localKey(o.secret));
}

export function localLoginRouter(
  cfg: LocalAuthConfig,
  opts: { ratePerMinute?: number; verify?: typeof verifyPassword } = {},
): Router {
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
      const access_token = await mintLocalToken({ secret: cfg.secret, subject: cfg.username, roles: ADMIN_ROLES });
      res.json({ access_token, token_type: "Bearer", expires_in: DEFAULT_TTL });
    },
  );
  return r;
}

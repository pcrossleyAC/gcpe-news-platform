import type { RequestHandler } from "express";
import { createRemoteJWKSet, decodeProtectedHeader, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from "jose";
import { LOCAL_AUDIENCE, LOCAL_ISSUER, localKey } from "./local";

export interface AuthContext {
  subject: string;
  roles: string[];
  claims: Record<string, unknown>;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      auth?: AuthContext;
    }
  }
}

export function entraJwks(tenantId: string): JWTVerifyGetKey {
  return createRemoteJWKSet(new URL(`https://login.microsoftonline.com/${tenantId}/discovery/v2.0/keys`));
}

export function entraIssuer(tenantId: string): string {
  return `https://login.microsoftonline.com/${tenantId}/v2.0`;
}

export interface BearerOptions {
  issuer?: string;
  audience?: string;
  keys?: JWTVerifyGetKey;
  local?: { secret: string };
}

export function requireBearer(opts: BearerOptions): RequestHandler {
  const entra = opts.issuer && opts.audience && opts.keys ? { issuer: opts.issuer, audience: opts.audience, keys: opts.keys } : null;
  const local = opts.local ? { key: localKey(opts.local.secret) } : null;
  return async (req, res, next) => {
    const header = req.header("authorization");
    if (!header?.startsWith("Bearer ")) return void res.status(401).json({ error: "missing bearer token" });
    const token = header.slice(7);
    try {
      // Branch on the token's own alg header, but always verify against the
      // pinned algorithm list for that branch — never let the header pick
      // which secret/keyset governs the check.
      const { alg } = decodeProtectedHeader(token);
      let payload: JWTPayload;
      if (alg === "HS256" && local) {
        ({ payload } = await jwtVerify(token, local.key, { issuer: LOCAL_ISSUER, audience: LOCAL_AUDIENCE, algorithms: ["HS256"] }));
      } else if (entra) {
        ({ payload } = await jwtVerify(token, entra.keys, { issuer: entra.issuer, audience: entra.audience, algorithms: ["RS256"] }));
      } else {
        throw new Error("no verifier configured for this token");
      }
      req.auth = {
        subject: String(payload.sub),
        roles: Array.isArray(payload.roles) ? payload.roles.map(String) : [],
        claims: payload as Record<string, unknown>,
      };
      next();
    } catch {
      // decodeProtectedHeader throws on malformed tokens too — same 401, not a 500.
      res.status(401).json({ error: "invalid token" });
    }
  };
}

export function requireRole(role: string): RequestHandler {
  return (req, res, next) => (req.auth?.roles.includes(role) ? next() : void res.status(403).json({ error: "forbidden" }));
}
